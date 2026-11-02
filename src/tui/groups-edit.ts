/**
 * Editing account groups.
 *
 * A group is keyed by a stable id that presets and pools reference; its
 * `label` is the name shown and the only thing a rename changes. So renaming
 * "Main" to "Team leads" breaks no preset that routes to it.
 */
import type { AccountGroup } from "../config.ts"

export type GroupMap = Record<string, AccountGroup>

/** `Team leads` -> `team-leads`; suffixed `-2`, `-3` until unique. */
export function groupIdFor(label: string, existing: GroupMap): string {
  const base =
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "group"
  let id = base
  for (let n = 2; Object.hasOwn(existing, id); n++) id = `${base}-${n}`
  return id
}

export function groupLabel(id: string, g: AccountGroup | undefined): string {
  return g?.label ?? id
}

export function createGroup(
  groups: GroupMap,
  label: string,
): { groups: GroupMap; id: string } | { error: string } {
  const name = label.trim()
  if (!name) return { error: "a group needs a name" }
  if (Object.entries(groups).some(([id, g]) => groupLabel(id, g) === name))
    return { error: "a group already has that name" }
  const id = groupIdFor(name, groups)
  return { groups: { ...groups, [id]: { accounts: [], label: name } }, id }
}

export function renameGroup(
  groups: GroupMap,
  id: string,
  label: string,
): { groups: GroupMap } | { error: string } {
  const name = label.trim()
  if (!Object.hasOwn(groups, id)) return { error: "no such group" }
  if (!name) return { error: "a group needs a name" }
  if (
    Object.entries(groups).some(
      ([other, g]) => other !== id && groupLabel(other, g) === name,
    )
  )
    return { error: "a group already has that name" }
  return { groups: { ...groups, [id]: { ...groups[id]!, label: name } } }
}

/** Presets (and their pools) that route to a group, which deleting would empty. */
export function presetsUsingGroup(
  presets: Record<
    string,
    { accounts?: string[]; pools?: { accounts?: string[] }[] }
  >,
  id: string,
): string[] {
  return Object.entries(presets)
    .filter(
      ([, p]) =>
        (p.accounts ?? []).includes(id) ||
        (p.pools ?? []).some((pl) => (pl.accounts ?? []).includes(id)),
    )
    .map(([name]) => name)
}

export function deleteGroup(groups: GroupMap, id: string): GroupMap {
  const { [id]: _gone, ...rest } = groups
  return rest
}

/**
 * Add or remove one account. Members are written as their account id
 * (`refOf`), and matched by resolving whatever spelling the config holds.
 */
export function toggleGroupMember(
  groups: GroupMap,
  id: string,
  source: string,
  resolve: (ref: string) => string | undefined,
  refOf: (source: string) => string,
): GroupMap {
  const g = groups[id]
  if (!g) return groups
  const has = g.accounts.some((r) => resolve(r) === source)
  const accounts = has
    ? g.accounts.filter((r) => resolve(r) !== source)
    : [...g.accounts, refOf(source)]
  return { ...groups, [id]: { ...g, accounts } }
}
