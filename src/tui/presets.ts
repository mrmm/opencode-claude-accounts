/**
 * Editing the named account arrangements from the TUI.
 *
 * A preset is a name, a strategy and a set of accounts -- the same shape the
 * account toggle already edits, so this reuses that idea rather than inventing
 * a second one. A preset built from `pools` -- tiered failover, a list of
 * groups each with its own strategy -- is edited by the same primitives one
 * tier at a time, which is what kept it from becoming a worse text editor than
 * the one already open.
 *
 * A preset's accounts are REFERENCES, not sources: a hand-written config says
 * "Acme 1" and the balancer resolves that by substring against the account
 * labels. So membership cannot be tested by comparing against a Keychain
 * source -- doing exactly that is what made every account render unticked in a
 * preset that plainly had three.
 *
 * Resolution is delegated to the balancer's own resolveRef rather than repeated
 * here. A second implementation that disagreed with it would tick boxes the
 * balancer does not honour, which is worse than not ticking them at all.
 *
 * What is WRITTEN depends on what was there: removing an account drops the
 * reference that resolved to it, so the hand-written "Acme 1" spellings
 * survive being edited around; adding one appends the exact source, since the
 * UI knows precisely which account was chosen and a fragment would be throwing
 * that away.
 */
import { resolveRef } from "../balance/index.ts"

/** A behaviour knob a preset may override, and how it is edited. */
export type PresetKnob = {
  key:
    | "strategy"
    | "order"
    | "autoSwitch"
    | "switchAt"
    | "switchWindow"
    | "ejectFor"
    | "weights"
  label: string
  /** Shown when the preset does not name it, so inherited reads as inherited. */
  inheritsFrom: string
}

/**
 * What a preset may override, in the order the editor shows it.
 *
 * `weights` is listed but only offered when the strategy is `weighted`: a
 * ratio for a strategy that does not read one is a setting that appears to do
 * something and does not.
 */
export const PRESET_KNOBS: PresetKnob[] = [
  { key: "strategy", label: "Strategy", inheritsFrom: "strategy" },
  { key: "order", label: "Order", inheritsFrom: "accounts" },
  { key: "weights", label: "Weights", inheritsFrom: "weights" },
  { key: "autoSwitch", label: "Auto-switch", inheritsFrom: "autoSwitch" },
  { key: "switchAt", label: "Switch at", inheritsFrom: "switchAt" },
  { key: "switchWindow", label: "Switch window", inheritsFrom: "switchWindow" },
  { key: "ejectFor", label: "Eject for", inheritsFrom: "ejectFor" },
]

/**
 * One fallback tier. Structurally the config's own `Pool`; mirrored here for
 * the same reason `Preset` is -- this file stays a leaf, and the shape is
 * three fields that have not changed since pools existed.
 */
export type Pool = {
  name: string
  accounts?: string[]
  strategy?: string
  weights?: Record<string, number>
}

export type Preset = {
  label?: string
  strategy?: string
  accounts?: string[]
  pools?: Pool[]
  weights?: Record<string, number>
  autoSwitch?: boolean
  switchAt?: number
  switchWindow?: string
  ejectFor?: number
}

export type PresetMap = Record<string, Preset>

/**
 * Whether this preset is the FLAT kind -- one list of accounts.
 *
 * Was `isEditable`, back when a tiered preset was shown and left alone. Both
 * kinds are editable now, by different screens, so the question the name asks
 * had to change with the answer.
 */
export function isFlat(p: Preset): boolean {
  return !Array.isArray(p.pools)
}

export type Member = { source: string; label?: string }

/**
 * Which accounts a preset actually contains, and which of its references go
 * nowhere.
 *
 * `unresolved` is returned rather than dropped: a reference that matches no
 * account, or matches two and is therefore refused, makes the preset quietly
 * smaller than it reads. That is worth showing.
 */
export function refsMembership(
  refs: readonly string[],
  members: readonly Member[],
): { sources: Set<string>; refFor: Map<string, string>; unresolved: string[] } {
  const sources = new Set<string>()
  const refFor = new Map<string, string>()
  const unresolved: string[] = []
  for (const ref of refs) {
    const source = resolveRef(ref, members)
    if (!source) {
      unresolved.push(ref)
      continue
    }
    sources.add(source)
    if (!refFor.has(source)) refFor.set(source, ref)
  }
  return { sources, refFor, unresolved }
}

export function presetMembership(
  preset: Preset,
  members: readonly Member[],
): { sources: Set<string>; refFor: Map<string, string>; unresolved: string[] } {
  return refsMembership(preset.accounts ?? [], members)
}

/**
 * Add or remove one account, returning the new preset.
 *
 * Refuses to empty the set: a preset with no accounts matches nothing, and the
 * balancer would fall through it silently rather than report it as broken.
 */
export function togglePresetAccount(
  preset: Preset,
  source: string,
  members: readonly Member[],
): Preset | null {
  const { sources, refFor } = presetMembership(preset, members)
  const current = preset.accounts ?? []

  if (sources.has(source)) {
    if (sources.size === 1) return null
    // Drop the reference that resolved to it, whatever spelling it used.
    const ref = refFor.get(source)
    return { ...preset, accounts: current.filter((r) => r !== ref) }
  }
  return { ...preset, accounts: [...current, source] }
}

/** Whether a name can be used for a new preset. */
export function validatePresetName(
  name: string,
  existing: PresetMap,
): { ok: true; name: string } | { ok: false; reason: string } {
  const trimmed = name.trim()
  if (trimmed === "") return { ok: false, reason: "cannot be empty" }
  // The name is a key in the config and is typed as a selection value, so it
  // stays in the character set that survives both without quoting.
  if (!/^[\w.-]+$/.test(trimmed)) {
    return {
      ok: false,
      reason: "letters, digits, dot, dash and underscore only",
    }
  }
  if (trimmed in existing)
    return { ok: false, reason: "a preset already has that name" }
  return { ok: true, name: trimmed }
}

/**
 * JSON at a given indentation, so a rewritten block still reads as part of the
 * file rather than one very long line.
 */
export function indentJson(value: unknown, indent: number): string {
  const text = JSON.stringify(value, null, 2)
  const pad = " ".repeat(indent)
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? line : pad + line))
    .join("\n")
}

/** Rows listing the presets, for the manage screen. */
export function presetRows(
  presets: PresetMap,
  selection: string,
): { title: string; value: string; description: string; category: string }[] {
  const rows = Object.entries(presets).map(([name, p]) => {
    const active = selection === `preset:${name}`
    const shape = isFlat(p)
      ? `${p.strategy ?? "sticky"} over ${(p.accounts ?? []).length} accounts`
      : `${poolsOf(p).length} tiers, ${poolsOf(p).reduce((n, q) => n + (q.accounts ?? []).length, 0)} accounts`
    return {
      title: p.label ? `${name}: ${p.label}` : name,
      value: name,
      description: active ? `${shape} - in use` : shape,
      category: "Presets",
    }
  })
  return rows
}

/**
 * One row per knob: what this preset does, and whether it said so itself.
 *
 * The distinction is the point. "Switch at: 0.95" is ambiguous between a
 * deliberate 0.95 and an inherited one, and the two behave differently when the
 * default later changes.
 */
export function knobRows(
  preset: Preset,
  defaults: Record<string, unknown>,
  render: (key: string, value: unknown) => string,
): { title: string; value: string; description: string; category: string }[] {
  const strategy = (preset.strategy ?? defaults.strategy) as string
  return PRESET_KNOBS.filter((k) => {
    // A knob only the strategy in force reads. Showing the others would be a
    // control that appears to do something and does not.
    if (k.key === "weights") return strategy === "weighted"
    if (k.key === "order") return strategy === "priority"
    return true
  }).map((k) => {
    const own = (preset as Record<string, unknown>)[k.key]
    const inherited = own === undefined
    const effective = inherited ? defaults[k.inheritsFrom] : own
    return {
      title: `${k.label}: ${render(k.key, effective)}`,
      value: `k:${k.key}`,
      description: inherited
        ? "inherited from the defaults"
        : "set by this preset",
      category: "Behaviour",
    }
  })
}

export type Move = "up" | "down" | "top" | "bottom"

/**
 * The list with one entry moved, or null when it would not move.
 *
 * Null rather than the same array, so a caller can skip a write that changes
 * nothing -- the config file's timestamp is what the plugin watches, and a
 * no-op write makes every reader re-read for no reason.
 */
/**
 * Move one element, or null when the move would change nothing.
 *
 * Generic because two things are ordered here and both are priority lists: the
 * accounts inside a tier, and the tiers themselves. One mover, so a no-op is
 * refused the same way in both -- an idle write still moves the mtime that
 * every reader watches.
 */
export function moveAt<T>(
  list: readonly T[],
  from: number,
  how: Move,
): T[] | null {
  if (from < 0 || from >= list.length) return null
  const to =
    how === "up"
      ? from - 1
      : how === "down"
        ? from + 1
        : how === "top"
          ? 0
          : list.length - 1
  if (to === from || to < 0 || to >= list.length) return null
  const next = [...list]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved as T)
  return next
}

export function moveRef(
  list: string[],
  ref: string,
  how: Move,
): string[] | null {
  return moveAt(list, list.indexOf(ref), how)
}

/**
 * The ordering screen: every account in the order `priority` will read it.
 *
 * Numbered, because "first" is the whole meaning of the list and a bare
 * sequence of names does not say that position is what matters.
 */
export function orderRows(
  list: string[],
  names: Map<string, string>,
  resolve: (ref: string) => string | undefined,
): { title: string; value: string; description: string }[] {
  return list.map((ref, i) => {
    const source = resolve(ref)
    const name = (source && names.get(source)) ?? ref
    return {
      title: `${i + 1}. ${name}`,
      value: `o:${ref}`,
      description:
        i === 0
          ? "served first while it is healthy"
          : `tried after ${i} other${i === 1 ? "" : "s"}`,
    }
  })
}

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

/**
 * A tiered preset carries `pools` instead of `accounts`: an ordered list of
 * fallback tiers, each a small preset of its own. Tier 1 serves while anything
 * in it is healthy; tier 2 is what happens when it is not.
 *
 * Everything below reuses the flat primitives rather than restating them --
 * a tier's membership is `refsMembership`, a tier's order is `moveAt`.
 */
export function isTiered(p: Preset): boolean {
  return Array.isArray(p.pools)
}

export function poolsOf(p: Preset): Pool[] {
  return Array.isArray(p.pools) ? p.pools : []
}

/** One row per tier, numbered, naming who is in it. */
export function poolRows(
  preset: Preset,
  names: Map<string, string>,
  members: readonly Member[],
): { title: string; value: string; description: string }[] {
  const pools = poolsOf(preset)
  return pools.map((pool, i) => {
    const { sources, unresolved } = refsMembership(pool.accounts ?? [], members)
    const who = [...sources].map((s) => names.get(s) ?? s)
    // An unresolved reference makes a tier quietly smaller than it reads, so
    // it is counted here rather than silently dropped.
    const missing = unresolved.length ? `, ${unresolved.length} unresolved` : ""
    return {
      title: `${i + 1}. ${pool.name || `tier ${i + 1}`}`,
      value: `p:${i}`,
      description:
        (who.length ? who.join(", ") : "empty") +
        (pool.strategy ? ` (${pool.strategy})` : "") +
        missing +
        (i === 0 ? " — served first" : ` — used when tier ${i} is spent`),
    }
  })
}

function withPools(preset: Preset, pools: Pool[]): Preset {
  return { ...preset, pools }
}

/** Add or remove one account in one tier. */
export function togglePoolAccount(
  preset: Preset,
  index: number,
  source: string,
  members: readonly Member[],
): Preset | null {
  const pools = poolsOf(preset)
  const pool = pools[index]
  if (!pool) return null
  const { sources, refFor } = refsMembership(pool.accounts ?? [], members)
  const current = pool.accounts ?? []

  if (sources.has(source)) {
    // A tier with nothing in it is dropped by the balancer anyway, so emptying
    // one is a slower way of deleting it. Deleting is the honest verb.
    if (sources.size === 1) return null
    const ref = refFor.get(source)
    const next = [...pools]
    next[index] = { ...pool, accounts: current.filter((r) => r !== ref) }
    return withPools(preset, next)
  }
  const next = [...pools]
  next[index] = { ...pool, accounts: [...current, source] }
  return withPools(preset, next)
}

export function movePool(
  preset: Preset,
  index: number,
  how: Move,
): Preset | null {
  const moved = moveAt(poolsOf(preset), index, how)
  return moved ? withPools(preset, moved) : null
}

export function addPool(preset: Preset, name: string): Preset {
  return withPools(preset, [...poolsOf(preset), { name, accounts: [] }])
}

/**
 * Remove a tier. The last one cannot go: a tiered preset with no tiers names
 * no accounts at all, which is a preset that can never serve.
 */
export function removePool(preset: Preset, index: number): Preset | null {
  const pools = poolsOf(preset)
  if (pools.length <= 1 || !pools[index]) return null
  return withPools(
    preset,
    pools.filter((_, i) => i !== index),
  )
}

export function renamePool(
  preset: Preset,
  index: number,
  name: string,
): Preset | null {
  const pools = poolsOf(preset)
  const pool = pools[index]
  if (!pool) return null
  const next = [...pools]
  next[index] = { ...pool, name }
  return withPools(preset, next)
}

export function setPoolStrategy(
  preset: Preset,
  index: number,
  strategy: string | null,
): Preset | null {
  const pools = poolsOf(preset)
  const pool = pools[index]
  if (!pool) return null
  const next = [...pools]
  if (strategy === null) {
    const { strategy: _drop, ...rest } = pool
    next[index] = rest
  } else {
    next[index] = { ...pool, strategy: strategy as Pool["strategy"] }
  }
  return withPools(preset, next)
}
