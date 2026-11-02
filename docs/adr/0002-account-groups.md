# 0002. Account groups have a stable id and an editable label

Status: Accepted

## Context

Related accounts (for example a main set and an alternate set) are easier to
read and route to together. Names change; presets that refer to a group must
not break when it is renamed.

## Decision

- `groups` is a generic config map: `{ "<id>": { "label"?: string, "accounts": string[] } }`.
  Nothing about group names is built in.
- The key is the id. Presets, pools and `accounts` reference the id, and a
  group reference expands to its members in one place (`expandGroupRefs`).
- The label is the shown name. Renaming in the TUI changes only the label.
- Empty groups are kept, so a group can exist between creation and its first
  member.
- The sidebar shows one collapsible section per group with combined room and
  request share; ungrouped accounts are listed under "Other".

## Consequences

- Groups do not nest.
- Deleting a group used by a preset empties that part of the preset; the TUI
  names the affected presets before confirming.
