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
 * Account references are written as Keychain sources rather than the label
 * fragments a human would type. A fragment is resolved by substring match and
 * an ambiguous one is refused, which is a fine trade when a person is choosing
 * the words; here the UI already knows exactly which account was picked, so
 * writing anything less exact would be throwing information away.
 */

export type Preset = {
  label?: string
  strategy?: string
  accounts?: string[]
  pools?: unknown[]
}

export type PresetMap = Record<string, Preset>

/** A preset this editor can safely change. */
export function isEditable(p: Preset): boolean {
  return !Array.isArray(p.pools)
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
): Preset | null {
  const current = preset.accounts ?? []
  if (current.includes(source)) {
    if (current.length === 1) return null
    return { ...preset, accounts: current.filter((s) => s !== source) }
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
