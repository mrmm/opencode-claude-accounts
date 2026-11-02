/**
 * One-time migration of a config file from source/label references to stable
 * account ids.
 *
 * Every place a config can name an account -- the top-level `accounts` list,
 * `weights` keys, `accountNames` keys, each preset's `accounts`, each preset's
 * `pools[].accounts` and their `weights`, and top-level `pools` -- is rewritten
 * from whatever reference form it used to the account's id. The `accountIds`
 * registry is written at the same time, built from the live identities and
 * carrying any `name` that `accountNames` had for the account.
 *
 * It runs once: when every enabled account has a resolvable id and the config
 * still holds a non-id reference. A second run finds nothing to change and is a
 * no-op, which is the idempotency the caller relies on to run it unconditionally.
 *
 * `planMigration` is pure -- it takes the parsed config and the members and
 * returns the rewritten values. `applyMigration` is the shell that reads the
 * file, backs it up, and writes through `setJsoncValue` so comments on the keys
 * it does not touch survive.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"

import { withFileLock } from "./file-lock.ts"
import { type AccountId, stripJsonc } from "../config.ts"
import { setJsoncValue } from "../config-edit.ts"
import { accountIdFor, suggestIds } from "./accounts-id.ts"
import { resolveRef, type Member } from "./balancer.ts"
import type { IdentityCache } from "./identity.ts"

/** The per-key rewrites a migration performs, plus the id registry it writes. */
export type MigrationPlan = {
  /** True when at least one reference changed. A false plan is a no-op. */
  changed: boolean
  accountIds: Record<string, AccountId>
  accounts?: string[]
  weights?: Record<string, number>
  accountNames?: Record<string, string>
  presets?: Record<string, unknown>
  pools?: unknown[]
}

/** The id for a member: its own `id`, falling back to its source. */
/**
 * Members with the id a migration should write: the registered one, else the
 * suggestion. planMigration only registers members that carry an id, so a
 * caller handing it bare Keychain accounts would rewrite nothing.
 */
export function membersForMigration(
  accounts: readonly { source: string; label?: string }[],
  identities: IdentityCache,
  registry: Record<string, AccountId>,
): Member[] {
  const sources = accounts.map((a) => a.source)
  const suggested = new Map(
    suggestIds(sources, identities, registry).map((s) => [s.source, s.id]),
  )
  return accounts.map((a) => {
    const registered = accountIdFor(a.source, identities, registry)
    const id = registered !== a.source ? registered : suggested.get(a.source)
    return {
      source: a.source,
      ...(a.label ? { label: a.label } : {}),
      ...(id && identities[a.source] ? { id } : {}),
    }
  })
}

function idOf(source: string, members: readonly Member[]): string {
  return members.find((m) => m.source === source)?.id ?? source
}

/** Resolve a reference to an id, or keep it verbatim when it resolves nowhere. */
function refToId(ref: string, members: readonly Member[]): string {
  const source = resolveRef(ref, members)
  return source ? idOf(source, members) : ref
}

function rewriteList(
  list: unknown,
  members: readonly Member[],
  touched: { any: boolean },
): string[] | undefined {
  if (!Array.isArray(list)) return undefined
  const out: string[] = []
  for (const ref of list) {
    if (typeof ref !== "string") continue
    const id = refToId(ref, members)
    if (id !== ref) touched.any = true
    if (!out.includes(id)) out.push(id)
  }
  return out
}

function rewriteKeyed<T>(
  map: unknown,
  members: readonly Member[],
  touched: { any: boolean },
): Record<string, T> | undefined {
  if (!map || typeof map !== "object" || Array.isArray(map)) return undefined
  const out: Record<string, T> = {}
  for (const [ref, value] of Object.entries(map as Record<string, T>)) {
    const id = refToId(ref, members)
    if (id !== ref) touched.any = true
    out[id] = value
  }
  return out
}

/**
 * Compute the rewrite. Builds the `accountIds` registry from every member that
 * has an id and a matching pair, naming each from `accountNames` when it had a
 * name under any of the account's old reference forms.
 */
export function planMigration(
  raw: Record<string, unknown>,
  members: readonly Member[],
  pairFor: (source: string) => { account: string; org: string } | undefined,
): MigrationPlan {
  const touched = { any: false }

  const accountNames = (raw.accountNames ?? {}) as Record<string, string>
  const nameFor = (source: string): string | undefined => {
    for (const [ref, name] of Object.entries(accountNames)) {
      if (resolveRef(ref, members) === source) return name
    }
    return undefined
  }

  const accountIds: Record<string, AccountId> = {}
  for (const member of members) {
    if (!member.id) continue
    const pair = pairFor(member.source)
    if (!pair) continue
    const entry: AccountId = { match: pair }
    const name = nameFor(member.source)
    if (name) entry.name = name
    accountIds[member.id] = entry
  }

  const plan: MigrationPlan = { changed: false, accountIds }

  const accounts = rewriteList(raw.accounts, members, touched)
  if (accounts) plan.accounts = accounts

  const weights = rewriteKeyed<number>(raw.weights, members, touched)
  if (weights) plan.weights = weights

  const names = rewriteKeyed<string>(raw.accountNames, members, touched)
  if (names) plan.accountNames = names

  if (raw.presets && typeof raw.presets === "object") {
    const presets: Record<string, unknown> = {}
    for (const [key, p] of Object.entries(
      raw.presets as Record<string, unknown>,
    )) {
      presets[key] = rewritePresetOrPool(p, members, touched)
    }
    plan.presets = presets
  }

  if (Array.isArray(raw.pools)) {
    plan.pools = raw.pools.map((p) => rewritePresetOrPool(p, members, touched))
  }

  // A change is: some reference was rewritten, OR the registry the file holds is
  // not already the one we would write. Comparing by value keeps a second run a
  // no-op even though `accountIds` is non-empty on both.
  const existingRegistry = JSON.stringify(raw.accountIds ?? {})
  const registryChanged = JSON.stringify(accountIds) !== existingRegistry
  plan.changed = touched.any || registryChanged
  return plan
}

/** Rewrite a preset or a pool: its `accounts`, its `weights`, and nested pools. */
function rewritePresetOrPool(
  node: unknown,
  members: readonly Member[],
  touched: { any: boolean },
): unknown {
  if (!node || typeof node !== "object" || Array.isArray(node)) return node
  const n = node as Record<string, unknown>
  const out: Record<string, unknown> = { ...n }
  const accounts = rewriteList(n.accounts, members, touched)
  if (accounts) out.accounts = accounts
  const weights = rewriteKeyed<number>(n.weights, members, touched)
  if (weights) out.weights = weights
  if (Array.isArray(n.pools)) {
    out.pools = n.pools.map((p) => rewritePresetOrPool(p, members, touched))
  }
  return out
}

const pad2 = (n: number) => String(n).padStart(2, "0")

/** `YYYYMMDD-HHmm` in local time, for the backup suffix. */
export function backupStamp(d: Date = new Date()): string {
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}`
  )
}

export type MigrationResult = {
  migrated: boolean
  backupPath?: string
  mapping: Record<string, AccountId>
}

/**
 * Read the config file, rewrite it in place to ids, and write a timestamped
 * backup first. A no-op plan writes nothing and takes no backup. Writes each
 * changed key through `setJsoncValue` so comments on untouched keys survive.
 */
export function applyMigration(
  path: string,
  members: readonly Member[],
  pairFor: (source: string) => { account: string; org: string } | undefined,
  now: Date = new Date(),
): MigrationResult {
  if (!existsSync(path)) return { migrated: false, mapping: {} }
  // Two OpenCode processes starting together both see "needs migration";
  // the lock makes the second re-read the first one's result and find nothing
  // to do, instead of overwriting it.
  return withFileLock(
    path,
    () => migrateLocked(path, members, pairFor, now),
    2_000,
  )
}

function migrateLocked(
  path: string,
  members: readonly Member[],
  pairFor: (source: string) => { account: string; org: string } | undefined,
  now: Date,
): MigrationResult {
  const text = readFileSync(path, "utf8")
  let raw: unknown
  try {
    raw = JSON.parse(stripJsonc(text))
  } catch {
    return { migrated: false, mapping: {} }
  }
  if (!raw || typeof raw !== "object") return { migrated: false, mapping: {} }

  const plan = planMigration(raw as Record<string, unknown>, members, pairFor)
  if (!plan.changed) return { migrated: false, mapping: plan.accountIds }

  const backupPath = `${path}.bak-${backupStamp(now)}`
  writeFileSync(backupPath, text, "utf8")

  let out = text
  const put = (key: string, value: unknown) => {
    const next = setJsoncValue(out, key, JSON.stringify(value, null, 2))
    if (next !== null) out = next
  }
  put("accountIds", plan.accountIds)
  if (plan.accounts) put("accounts", plan.accounts)
  if (plan.weights) put("weights", plan.weights)
  if (plan.accountNames) put("accountNames", plan.accountNames)
  if (plan.presets) put("presets", plan.presets)
  if (plan.pools) put("pools", plan.pools)

  // Config is the one file a torn write would make unloadable; the backup
  // above is not a substitute for never leaving it half-written.
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, out, "utf8")
  renameSync(tmp, path)
  return { migrated: true, backupPath, mapping: plan.accountIds }
}
