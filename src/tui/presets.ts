/**
 * Editing the named account arrangements from the TUI.
 *
 * A preset is a name, a strategy and a set of accounts -- the same shape the
 * account toggle already edits, so this reuses that idea rather than inventing
 * a second one. What it deliberately does NOT edit is a preset built from
 * `pools`: tiered failover is a list of groups each with its own strategy, and
 * a one-line dialog editing that becomes a worse text editor than the one
 * already open. Those are shown, marked, and left alone.
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
  { key: "weights", label: "Weights", inheritsFrom: "weights" },
  { key: "autoSwitch", label: "Auto-switch", inheritsFrom: "autoSwitch" },
  { key: "switchAt", label: "Switch at", inheritsFrom: "switchAt" },
  { key: "switchWindow", label: "Switch window", inheritsFrom: "switchWindow" },
  { key: "ejectFor", label: "Eject for", inheritsFrom: "ejectFor" },
]

export type Preset = {
  label?: string
  strategy?: string
  accounts?: string[]
  pools?: unknown[]
  weights?: Record<string, number>
  autoSwitch?: boolean
  switchAt?: number
  switchWindow?: string
  ejectFor?: number
}

export type PresetMap = Record<string, Preset>

/** A preset this editor can safely change. */
export function isEditable(p: Preset): boolean {
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
export function presetMembership(
  preset: Preset,
  members: readonly Member[],
): { sources: Set<string>; refFor: Map<string, string>; unresolved: string[] } {
  const sources = new Set<string>()
  const refFor = new Map<string, string>()
  const unresolved: string[] = []
  for (const ref of preset.accounts ?? []) {
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
    const shape = isEditable(p)
      ? `${p.strategy ?? "sticky"} over ${(p.accounts ?? []).length} accounts`
      : `${(p.pools as unknown[]).length} tiers - read only here`
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
  return PRESET_KNOBS.filter(
    (k) => k.key !== "weights" || strategy === "weighted",
  ).map((k) => {
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
