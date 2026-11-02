/**
 * The account-id registry: mapping a Keychain source to a stable, reader-chosen
 * id and back, plus suggesting an id for an account that has none yet.
 *
 * An id is bound to an account's `{ account, org }` pair (see identity.ts), not
 * to its source name, so renaming a Keychain entry or re-logging in keeps the
 * same id. Resolution is therefore: source -> identity -> the id whose `match`
 * equals that pair.
 *
 * Pure throughout: every function takes the identity cache and the registry as
 * arguments. No file, no clock. The act of reading those files happens in the
 * caller.
 */

import type { AccountId } from "../config.ts"
import { ACCOUNT_ID_RE } from "../config.ts"
import type { AccountIdentity, IdentityCache } from "./identity.ts"

/** Lower-case, collapse non-alphanumerics to single dashes, trim them. */
export function slug(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return s || "account"
}

function pairEquals(
  identity: AccountIdentity | undefined,
  match: AccountId["match"],
): boolean {
  return (
    identity?.accountUuid === match.account && identity?.orgUuid === match.org
  )
}

/**
 * The id for a source, or the source itself when unknown.
 *
 * Returning the source rather than undefined means every caller gets a usable
 * key: an un-migrated install keys its cache and presets by source exactly as
 * before, and migration is what turns those into ids.
 */
export function accountIdFor(
  source: string,
  identities: IdentityCache,
  registry: Record<string, AccountId>,
): string {
  const identity = identities[source]
  if (identity) {
    for (const [id, entry] of Object.entries(registry)) {
      if (pairEquals(identity, entry.match)) return id
    }
  }
  return source
}

/**
 * The source currently backing an id, or undefined when no live account matches
 * its pair. Reverses `accountIdFor` through the identity cache.
 */
export function sourceForId(
  id: string,
  identities: IdentityCache,
  registry: Record<string, AccountId>,
): string | undefined {
  const entry = registry[id]
  if (!entry) return undefined
  for (const [source, identity] of Object.entries(identities)) {
    if (pairEquals(identity, entry.match)) return source
  }
  return undefined
}

/**
 * Display-name overrides keyed by Keychain source, for the renderers.
 *
 * `accountIds.<id>.name` is the one place a name is set; legacy `accountNames`
 * entries still apply to accounts that have no id yet, and lose to an id name.
 */
export function namesBySource(
  registry: Record<string, AccountId>,
  identities: IdentityCache,
  legacy: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = { ...legacy }
  for (const [id, entry] of Object.entries(registry)) {
    if (!entry.name) continue
    const source = sourceForId(id, identities, registry)
    if (source) out[source] = entry.name
  }
  return out
}

export type Suggestion = { source: string; id: string }

/**
 * Suggest an id for every source that has no registry entry yet.
 *
 * Base id = slug(orgName). On a clash -- two accounts slugging to the same org
 * name -- the ones that share an org are told apart by the email local part
 * (`acme-alice`, `acme-bob`); a residual clash, or a missing email, falls back
 * to a numeric suffix (`acme-2`, `acme-3`). Ids already taken by the registry or
 * by an earlier suggestion in this run are never reused.
 */
export function suggestIds(
  sources: readonly string[],
  identities: IdentityCache,
  registry: Record<string, AccountId>,
): Suggestion[] {
  const taken = new Set<string>(Object.keys(registry))
  const out: Suggestion[] = []

  // Count how many unmatched sources share each base slug, so a lone account
  // keeps the clean `acme` and only genuine collisions get disambiguated.
  const unmatched = sources.filter(
    (s) => accountIdFor(s, identities, registry) === s,
  )
  const baseCount = new Map<string, number>()
  for (const source of unmatched) {
    const base = baseFor(source, identities)
    baseCount.set(base, (baseCount.get(base) ?? 0) + 1)
  }

  for (const source of unmatched) {
    const base = baseFor(source, identities)
    const email = identities[source]?.email
    let candidate: string
    if ((baseCount.get(base) ?? 0) > 1 && email) {
      const local = slug(email.split("@")[0] ?? "")
      candidate = unique(`${base}-${local}`, taken)
    } else {
      candidate = unique(base, taken)
    }
    taken.add(candidate)
    out.push({ source, id: candidate })
  }
  return out
}

/**
 * The key a cache WRITE for this source should use: its id when registered,
 * else the source. New writes key by id; this is what they call to get it.
 */
export function cacheKeyFor(
  source: string,
  identities: IdentityCache,
  registry: Record<string, AccountId>,
): string {
  return accountIdFor(source, identities, registry)
}

/**
 * The keys a cache READ for this source should try, newest convention first:
 * the id (how new writes key), then the raw source (how old writes keyed, and
 * un-migrated installs still key). Deduplicated, so an unregistered account
 * yields a single key.
 */
export function cacheReadKeys(
  source: string,
  identities: IdentityCache,
  registry: Record<string, AccountId>,
): string[] {
  const id = accountIdFor(source, identities, registry)
  return id === source ? [source] : [id, source]
}

function baseFor(source: string, identities: IdentityCache): string {
  const name = identities[source]?.orgName
  const base = name ? slug(name) : slug(source)
  // The slug charset is a subset of the id charset, so this always holds; the
  // guard is here so a future slug change cannot silently emit an invalid id.
  return ACCOUNT_ID_RE.test(base) ? base : "account"
}

function unique(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}
