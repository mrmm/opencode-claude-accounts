/**
 * What the TUI shows about the active account, and what the picker offers.
 *
 * Pure on purpose. The TUI entry point is JSX running inside the TUI process,
 * which has no test harness here and cannot be imported by node:test; keeping
 * every decision in this file means the part that can be wrong is the part that
 * is covered. The entry point only reads files and renders what this returns.
 *
 * It is also why this duplicates nothing from the server plugin: the TUI runs in
 * a different process and shares state with it only through the selection file
 * and the quota cache on disk.
 */
import type { QuotaCache, SessionUsage } from "../balance/index.ts"

export type ChipAccount = { source: string; label: string }

export type ChipInput = {
  accounts: ChipAccount[]
  quota: QuotaCache
  /** Selection file contents: `preset:<name>`, `__auto__`, or a source. */
  selection: string
  activeSource: string | null
  /**
   * Requests served per account, for the share column. Optional because the
   * chip is useful without it and the caller may not have paid for the read.
   */
  requests?: Record<string, number>
  /**
   * Accounts excluded by the allow-list and therefore not listed.
   *
   * Reported rather than ignored: an account silently missing from a list of
   * accounts is indistinguishable from one the plugin failed to see.
   */
  hiddenCount?: number
  now?: number
}

/**
 * A row in the account picker.
 *
 * Shaped as TuiDialogSelectOption, which names the visible text `title` (not
 * `label`) and has no `hint`. Matching the host type here rather than mapping in
 * the entry point is what lets `tsc` prove the picker is well-formed -- the
 * first draft used `label`/`hint` and only the type-check caught it.
 */
export type PickerOption = {
  title: string
  value: string
  description?: string
  category?: string
}

const AUTO = "__auto__"
const PRESET = "preset:"

/**
 * "Claude Team - Acme 1 - Wings of Freedom" is 41 columns next to a prompt.
 * The distinguishing part is the tail, not the vendor prefix every account
 * shares, so drop the common lead-in rather than truncating the end.
 */
export function shortLabel(label: string): string {
  const parts = label
    .split(" - ")
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length > 1) return parts[parts.length - 1]!
  return label.replace(/^Claude (Code|Team)\s*/i, "").trim() || label
}

/**
 * "Team 3", when the label carries a number.
 *
 * Accounts are usually numbered by whoever set them up, and that number is what
 * a person calls them. The rest of the label -- the vendor prefix, the
 * organisation, the nickname -- is either shared by every account or too long
 * for a sidebar column.
 */
export function teamName(label: string): string | null {
  // The LAST number, because a label like "Claude Team - Acme 3 - Nickname"
  // carries the vendor's word "Team" early and the meaningful index later.
  const matches = label.match(/\d+/g)
  if (!matches || matches.length === 0) return null
  return `Team ${matches[matches.length - 1]}`
}

/**
 * A display name per account, short where that is unambiguous.
 *
 * Naming is a function of the whole set rather than of one label, which is the
 * only way a collision can be noticed at all: two accounts whose labels both
 * end in 1 cannot both be "Team 1", so both keep their longer name instead of
 * one silently shadowing the other.
 */
export function shortNames(accounts: ChipAccount[]): Map<string, string> {
  const count = new Map<string, number>()
  for (const a of accounts) {
    const t = teamName(a.label)
    if (t) count.set(t, (count.get(t) ?? 0) + 1)
  }
  const out = new Map<string, string>()
  for (const a of accounts) {
    const t = teamName(a.label)
    const chosen = t && count.get(t) === 1 ? t : shortLabel(a.label)
    // A label can shorten to nothing -- an empty one, or one that is only the
    // vendor prefix. A blank row would be worse than a cryptic one, so the tail
    // of the Keychain source stands in.
    out.set(a.source, chosen || a.source.slice(-8))
  }
  return out
}

/** Whole percent, or undefined when nothing has been observed for that window. */
function pct(v: number | undefined): number | undefined {
  return typeof v === "number" ? Math.round(v * 100) : undefined
}

export function utilisation(
  quota: QuotaCache,
  source: string | null,
): { five?: number; week?: number; rejected: boolean } {
  const q = source ? quota?.[source] : undefined
  return {
    five: pct(q?.fiveHour?.utilization),
    week: pct(q?.sevenDay?.utilization),
    // A rejected window is the one fact worth a colour change: the account is
    // not merely busy, it is refusing requests.
    rejected:
      q?.fiveHour?.status === "rejected" || q?.sevenDay?.status === "rejected",
  }
}

/**
 * Which account is serving, inferred from the cache.
 *
 * The TUI runs in a different process from the balancer and cannot see its
 * in-memory choice. Every response updates the quota entry for the account that
 * served it, so the newest `observedAt` is that account. This is an inference,
 * and it is wrong in exactly one case worth knowing: before the first response
 * of a session there is nothing newer to point at, so it reports whatever
 * served last time.
 */
export function mostRecentlyObserved(quota: QuotaCache): string | null {
  let best: string | null = null
  let at = -Infinity
  for (const [source, q] of Object.entries(quota ?? {})) {
    const seen = (q as { observedAt?: number } | undefined)?.observedAt
    if (typeof seen === "number" && seen > at) {
      at = seen
      best = source
    }
  }
  return best
}

/**
 * The one-line chip. Kept to roughly 24 columns because it sits beside the
 * prompt, where anything longer pushes the input around.
 */
export function formatChip(input: ChipInput): string {
  const active = input.accounts.find((a) => a.source === input.activeSource)
  const name = active
    ? (shortNames(input.accounts).get(active.source) ??
      shortLabel(active.label))
    : "no account"
  const { five, week, rejected } = utilisation(input.quota, input.activeSource)

  const load =
    five === undefined && week === undefined
      ? ""
      : ` ${[five, week].map((n) => (n === undefined ? "–" : `${n}%`)).join("/")}`

  const mode = input.selection.startsWith(PRESET)
    ? `⇄ ${input.selection.slice(PRESET.length)}`
    : input.selection === AUTO
      ? "⇄ auto"
      : "⏻"

  return `${mode} ${name}${load}${rejected ? " !" : ""}`
}

/**
 * The sidebar block: a heading line plus one line per account.
 *
 * The prompt-right chip has to fit beside an input box; the sidebar has a
 * column to itself, so this is where the full picture goes -- every account,
 * both windows, and which one is serving.
 */
export function sidebarLines(input: ChipInput): {
  heading: string
  rows: {
    name: string
    detail: string
    active: boolean
    rejected: boolean
  }[]
} {
  const mode = input.selection.startsWith(PRESET)
    ? `balancing - ${input.selection.slice(PRESET.length)}`
    : input.selection === AUTO
      ? "balancing - auto"
      : "pinned"
  const hidden = input.hiddenCount ?? 0
  const heading = hidden > 0 ? `${mode}, ${hidden} off` : mode

  const total = Object.values(input.requests ?? {}).reduce((n, r) => n + r, 0)
  const names = shortNames(input.accounts)

  const rows = input.accounts.map((a) => {
    const { five, week, rejected } = utilisation(input.quota, a.source)
    const quota = five === undefined ? "no reading" : `${five}%/${week ?? "-"}%`

    // Share of requests, not of quota: it answers "is the balancer actually
    // spreading load", which the quota percentages do not -- two accounts can
    // sit at the same utilisation while one serves everything.
    const served = input.requests?.[a.source]
    const share =
      total > 0 && served !== undefined
        ? ` - ${Math.round((served / total) * 100)}% reqs`
        : ""

    return {
      name: names.get(a.source) ?? shortLabel(a.label),
      detail: `${quota}${share}`,
      active: a.source === input.activeSource,
      rejected,
    }
  })

  return { heading, rows }
}

/**
 * Picker rows: presets first, then Auto, then individual accounts.
 *
 * Deliberately the same ordering as the `/connect` switcher, so the two do not
 * disagree about what the choices are — but selecting one of these writes the
 * selection file and nothing else, with no auth flow to trigger.
 */
export function buildPickerOptions(input: {
  accounts: ChipAccount[]
  presets: Record<string, { label?: string; strategy?: string }>
  quota: QuotaCache
  selection: string
}): PickerOption[] {
  const mark = (value: string, row: PickerOption): PickerOption =>
    input.selection === value ? { ...row, description: "active" } : row

  const presets = Object.entries(input.presets).map(([name, p]) =>
    mark(`${PRESET}${name}`, {
      title: `${p.label ?? name}${p.strategy ? ` - ${p.strategy}` : ""}`,
      value: `${PRESET}${name}`,
      category: "Balancing",
    }),
  )

  const auto = mark(AUTO, {
    title: "Auto - balance across all",
    value: AUTO,
    category: "Balancing",
  })

  const pickerNames = shortNames(input.accounts)
  const accounts = input.accounts.map((a) => {
    const { five, week, rejected } = utilisation(input.quota, a.source)
    const load =
      five === undefined
        ? ""
        : ` [${five}%/${week ?? "-"}%${rejected ? " !" : ""}]`
    return mark(a.source, {
      title: `${pickerNames.get(a.source) ?? shortLabel(a.label)}${load}`,
      value: a.source,
      category: "Pin to one account",
    })
  })

  return [...presets, auto, ...accounts]
}

/**
 * Rows for the per-session stats popup.
 *
 * A DialogSelect rather than a bespoke table: it brings filtering and scrolling,
 * and a stats list wants both once there is more than a screenful. Nothing is
 * selectable in a meaningful sense, so the rows carry their whole story in
 * `title` and `description`.
 */
export function sessionRows(
  sessions: SessionUsage[],
  now: number = Date.now(),
): PickerOption[] {
  return sessions.map((s) => {
    const err = s.errors > 0 ? `, ${s.errors} err` : ""
    const spread =
      s.accounts.length > 1 ? `${s.accounts.length} accounts` : "1 account"
    return {
      // The id is long and the tail is what distinguishes one from another.
      title: `${s.session.slice(-8)}  ${s.requests} req${err}`,
      value: s.session,
      description: `${spread} - ${s.models.map(shortModel).join(", ")} - avg ${fmtMs(s.avg_ms)} - ${ago(s.last_at, now)}`,
    }
  })
}

/** "claude-opus-5" reads as "opus-5" in a list where every row says claude. */
export function shortModel(model: string): string {
  return model.replace(/^claude-/, "")
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

/** Relative time, coarse: the popup answers "recently?", not "when exactly". */
export function ago(at: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

/**
 * Which accounts the allow-list currently permits.
 *
 * `accounts: []` means every account, so an empty list has to be expanded
 * before it can be reasoned about -- otherwise "is this one enabled" answers
 * no for all of them while all of them are serving.
 */
export function enabledSources(
  all: ChipAccount[],
  allowList: string[],
): string[] {
  if (allowList.length === 0) return all.map((a) => a.source)
  // An entry matching nothing is ignored rather than stranding the plugin, so
  // the same is done here: the list is filtered against what actually exists.
  const known = new Set(all.map((a) => a.source))
  const kept = allowList.filter((s) => known.has(s))
  return kept.length > 0 ? kept : all.map((a) => a.source)
}

/**
 * The allow-list after including or excluding one account, or null to refuse.
 *
 * Refuses to remove the last one: an empty allow-list does not mean "no
 * accounts", it means "all accounts", so disabling the final entry would
 * silently re-enable everything -- the exact opposite of what was asked.
 *
 * Returns `[]` when everything ends up enabled, because that is how the config
 * spells "all" and writing four entries that happen to be all of them would
 * pin the set: an account added later would arrive disabled.
 */
export function toggleAccount(
  all: ChipAccount[],
  allowList: string[],
  source: string,
): string[] | null {
  const enabled = new Set(enabledSources(all, allowList))
  if (enabled.has(source)) {
    if (enabled.size === 1) return null
    enabled.delete(source)
  } else {
    enabled.add(source)
  }
  if (enabled.size === all.length) return []
  // Preserve the configured order, which is preference order.
  return all.map((a) => a.source).filter((s) => enabled.has(s))
}

/** Rows for the include/exclude dialog. */
export function accountToggleRows(
  all: ChipAccount[],
  allowList: string[],
  quota: QuotaCache,
): PickerOption[] {
  const enabled = new Set(enabledSources(all, allowList))
  const names = shortNames(all)
  return all.map((a) => {
    const { five, week, rejected } = utilisation(quota, a.source)
    const state = enabled.has(a.source) ? "[x]" : "[ ]"
    const load = five === undefined ? "no reading" : `${five}%/${week ?? "-"}%`
    return {
      title: `${state} ${names.get(a.source) ?? a.source}`,
      value: a.source,
      description: `${rejected ? "refusing - " : ""}${load} - ${shortLabel(a.label)}`,
    }
  })
}
