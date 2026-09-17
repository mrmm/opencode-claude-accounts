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
import type { QuotaCache } from "../balance/index.ts"

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
  const name = active ? shortLabel(active.label) : "no account"
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
  const heading = input.selection.startsWith(PRESET)
    ? `balancing - ${input.selection.slice(PRESET.length)}`
    : input.selection === AUTO
      ? "balancing - auto"
      : "pinned"

  const total = Object.values(input.requests ?? {}).reduce((n, r) => n + r, 0)

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
      name: shortLabel(a.label),
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

  const accounts = input.accounts.map((a) => {
    const { five, week, rejected } = utilisation(input.quota, a.source)
    const load =
      five === undefined
        ? ""
        : ` [${five}%/${week ?? "-"}%${rejected ? " !" : ""}]`
    return mark(a.source, {
      title: `${shortLabel(a.label)}${load}`,
      value: a.source,
      category: "Pin to one account",
    })
  })

  return [...presets, auto, ...accounts]
}
