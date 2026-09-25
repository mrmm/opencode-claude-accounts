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
import type {
  QuotaCache,
  SessionDetail,
  SessionUsage,
} from "../balance/index.ts"
import { creditHeadroom, formatDuration } from "../balance/index.ts"

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
   * Display names, already resolved. Passed in rather than derived here so the
   * configured overrides apply everywhere at once and cannot drift between the
   * chip, the sidebar and the pickers.
   */
  names?: Map<string, string>
  /**
   * Warning thresholds, so the colouring matches the numbers the plugin would
   * warn about rather than a second opinion invented for the sidebar.
   */
  thresholds?: { warnAt: number; weeklyWarnAt: number }
  /**
   * Accounts excluded by the allow-list and therefore not listed.
   *
   * Reported rather than ignored: an account silently missing from a list of
   * accounts is indistinguishable from one the plugin failed to see.
   */
  hiddenCount?: number
  /** Unix seconds, injectable so a countdown can be asserted. */
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
 * Field separator for every string this plugin puts on screen.
 *
 * A middle dot, not a hyphen: hyphens occur *inside* the values being
 * separated -- model names (haiku-4-5), preset names (rr-123), account labels
 * (Wings of Freedom) -- so "refusing - 104%/57% - Wings of" read as one run of
 * text with no visible structure.
 */
export const SEP = " \u00b7 "

/** Nothing observed for a window. An em dash, never a hyphen, never "-". */
const NONE = "\u2014"

/**
 * Both quota windows, each labelled.
 *
 * "13%/56%" was the old rendering and it never said which number was which --
 * the two windows behave completely differently (one resets in hours, the other
 * in a week), so reading the wrong one leads to the wrong decision. A percentage
 * above 100 is not a bug: it means the account is past its threshold.
 */
export function quotaText(
  quota: QuotaCache,
  source: string | null,
  opts: {
    includeWeek?: boolean
    resets?: boolean
    now?: number
    /** Append the money once credits are actually covering this account. */
    spend?: boolean
  } = {},
): string {
  const { five, week, fiveIn, weekIn, rejected } = utilisation(
    quota,
    source,
    opts.now,
  )
  if (five === undefined && week === undefined) return "no reading"
  // Percentage then time-remaining, the shape the account switcher already
  // uses, so the two surfaces read the same way.
  const left = (secs: number | undefined) =>
    opts.resets && secs !== undefined ? ` ${formatDuration(secs)}` : ""
  const parts = [`5h ${five === undefined ? NONE : `${five}%`}${left(fiveIn)}`]
  if (opts.includeWeek !== false) {
    parts.push(`wk ${week === undefined ? NONE : `${week}%`}${left(weekIn)}`)
  }
  // Said in a word rather than punctuation: "!" needs a legend, "refused" does
  // not, and this is the one state that means requests are failing right now.
  if (rejected) parts.unshift("refused")

  // Always, when there is a funded line: knowing an account has 66 EUR left
  // is what tells you it can take over, and that is worth knowing BEFORE the
  // switch rather than after. spendText itself stays quiet when there is no
  // line to report.
  if (opts.spend) {
    const spent = spendText(quota, source)
    if (spent) parts.push(spent)
  }
  return parts.join(SEP)
}

/**
 * How an account is doing, as one of four states.
 *
 * Colour carries this and nothing else. The previous rendering used colour for
 * two unrelated facts at once -- red for refusing, green for serving, muted for
 * everything else -- so a healthy idle account and an exhausted idle account
 * were the same colour, which is the one comparison a list of accounts exists
 * to make. Which account is serving is now a marker and a brightness; hue is
 * free to mean load.
 */
/**
 * `paid` sits between warn and critical: the included allowance is gone, but
 * credits are covering the account, so it is still serving -- for money. It is
 * a state of its own because the two neighbours are both wrong for it. Calling
 * it critical strands a working account; calling it ok hides a bill.
 */
export type Health = "unknown" | "ok" | "warn" | "paid" | "critical"

/** Credits exist, are funded, and are not yet spent out. */
export function onCredits(quota: QuotaCache, source: string | null): boolean {
  return creditHeadroom((source ? quota?.[source] : undefined)?.extra)
}

const money = (minor: number) => (minor / 100).toFixed(2)

/**
 * `credits 113.78/200.00 EUR`, or "" when there is no credit line to report.
 *
 * Shown whenever a FUNDED line exists, not only while it is being drawn on:
 * the balance is what decides whether an account can take over later, so
 * hiding it until the moment it matters hides it exactly when it is too late
 * to act on. An unfunded line (a real 0.00/0.00) reports nothing, because
 * "credits 0.00/0.00" is a fact about nothing.
 *
 * The word is `credits`, not `paid`: this is a balance, not a state. Whether
 * the account is currently spending is carried by the `paid` health colour.
 */
export function spendText(quota: QuotaCache, source: string | null): string {
  const x = (source ? quota?.[source] : undefined)?.extra
  if (!x?.enabled || x.usedMinor === undefined || x.limitMinor === undefined) {
    return ""
  }
  if (x.limitMinor <= 0) return ""
  return `credits ${money(x.usedMinor)}/${money(x.limitMinor)} ${x.currency ?? ""}`.trim()
}

/**
 * Credits are not merely available -- they are being spent right now.
 *
 * `onCredits` alone was the wrong question: an account at 40% with credits
 * enabled is not paying for anything, and labelling it "paid" would put a
 * bill on every healthy row.
 */
export function payingNow(quota: QuotaCache, source: string | null): boolean {
  if (!onCredits(quota, source)) return false
  const { five, week, rejected } = utilisation(quota, source)
  return rejected || (five ?? 0) >= 100 || (week ?? 0) >= 100
}

export function accountHealth(
  quota: QuotaCache,
  source: string | null,
  thresholds: { warnAt: number; weeklyWarnAt: number },
): Health {
  const { five, week, rejected } = utilisation(quota, source)
  if (five === undefined && week === undefined && !rejected) return "unknown"

  // Spent, by refusal or by arithmetic. Which of the two states that is
  // depends on whether anything is covering the overflow.
  const spent = rejected || (five ?? 0) >= 100 || (week ?? 0) >= 100
  if (spent) return onCredits(quota, source) ? "paid" : "critical"
  // Below this line the account is inside its allowance, so nothing is owed.
  if (five === undefined && week === undefined) return "unknown"
  if (
    (five ?? 0) >= Math.round(thresholds.warnAt * 100) ||
    (week ?? 0) >= Math.round(thresholds.weeklyWarnAt * 100)
  ) {
    return "warn"
  }
  return "ok"
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
export function shortNames(
  accounts: ChipAccount[],
  overrides: Record<string, string> = {},
  resolve?: (ref: string, accounts: ChipAccount[]) => string | undefined,
): Map<string, string> {
  // An explicit name wins outright, and is not subject to the collision rule
  // below: the derived names are guesses and deserve a guard, a name someone
  // typed is a decision.
  const named = new Map<string, string>()
  for (const [ref, name] of Object.entries(overrides)) {
    const source = resolve
      ? resolve(ref, accounts)
      : accounts.find((a) => a.source === ref)?.source
    if (source) named.set(source, name)
  }
  const derived = accounts.filter((a) => !named.has(a.source))

  const count = new Map<string, number>()
  for (const a of derived) {
    const t = teamName(a.label)
    if (t) count.set(t, (count.get(t) ?? 0) + 1)
  }
  const out = new Map(named)
  for (const a of derived) {
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

/**
 * Seconds until a window turns over, or undefined when that is not known.
 *
 * A non-positive `resetsAt` reads as unknown rather than as 1970: the header
 * never carries one, and a zero there means the field was never filled in.
 */
function until(
  w: { resetsAt?: number } | undefined,
  now: number,
): number | undefined {
  if (!w || typeof w.resetsAt !== "number" || w.resetsAt <= 0) return undefined
  return w.resetsAt - now
}

/** A window whose reset moment has already passed. */
const gone = (v: number | undefined) => v !== undefined && v <= 0

export function utilisation(
  quota: QuotaCache,
  source: string | null,
  now: number = Math.floor(Date.now() / 1000),
): {
  five?: number
  week?: number
  /** Seconds until reset, omitted when unknown or already past. */
  fiveIn?: number
  weekIn?: number
  rejected: boolean
} {
  const q = source ? quota?.[source] : undefined
  const fiveIn = until(q?.fiveHour, now)
  const weekIn = until(q?.sevenDay, now)
  // A window past its reset holds a reading from before the turnover, so it is
  // 0 and not whatever was last seen. The account switcher already renders it
  // this way; two surfaces disagreeing about one number is worse than either
  // answer being the wrong one to prefer.
  return {
    five: gone(fiveIn) ? 0 : pct(q?.fiveHour?.utilization),
    week: gone(weekIn) ? 0 : pct(q?.sevenDay?.utilization),
    fiveIn: gone(fiveIn) ? undefined : fiveIn,
    weekIn: gone(weekIn) ? undefined : weekIn,
    // A rejected window is the one fact worth a colour change: the account is
    // not merely busy, it is refusing requests. A refusal from a window that
    // has since turned over is not a refusal now.
    rejected:
      (q?.fiveHour?.status === "rejected" && !gone(fiveIn)) ||
      (q?.sevenDay?.status === "rejected" && !gone(weekIn)),
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

  // The 5h window only: this sits beside the prompt, and it is the window that
  // moves during a session. The weekly figure is in the sidebar, which has room.
  const load = `${SEP}${quotaText(input.quota, input.activeSource, { includeWeek: false })}${
    payingNow(input.quota, input.activeSource) ? `${SEP}paid` : ""
  }`

  const mode = input.selection.startsWith(PRESET)
    ? `⇄ ${input.selection.slice(PRESET.length)}`
    : input.selection === AUTO
      ? "⇄ auto"
      : "⏻"

  return `${mode}${SEP}${name}${load}`
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
    health: Health
  }[]
} {
  const mode = input.selection.startsWith(PRESET)
    ? `balancing - ${input.selection.slice(PRESET.length)}`
    : input.selection === AUTO
      ? "balancing - auto"
      : "pinned"
  const hidden = input.hiddenCount ?? 0
  const heading = hidden > 0 ? `${mode}${SEP}${hidden} off` : mode

  const total = Object.values(input.requests ?? {}).reduce((n, r) => n + r, 0)
  const names = input.names ?? shortNames(input.accounts)

  const rows = input.accounts.map((a) => {
    const quota = quotaText(input.quota, a.source, {
      resets: true,
      spend: true,
      now: input.now,
    })
    const health = accountHealth(
      input.quota,
      a.source,
      input.thresholds ?? { warnAt: 0.9, weeklyWarnAt: 0.85 },
    )

    // Share of requests, not of quota: it answers "is the balancer actually
    // spreading load", which the quota percentages do not -- two accounts can
    // sit at the same utilisation while one serves everything.
    const served = input.requests?.[a.source]
    const share =
      total > 0 && served !== undefined
        ? `${SEP}${Math.round((served / total) * 100)}% reqs`
        : ""

    return {
      name: names.get(a.source) ?? shortLabel(a.label),
      detail: `${quota}${share}`,
      active: a.source === input.activeSource,
      health,
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
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

const two = (n: number) => String(n).padStart(2, "0")

/**
 * When a window resets, as a clock time rather than a countdown.
 *
 * A countdown answers "how long", which is what the sidebar needs while you
 * wait. Choosing an account to switch TO is a different question -- "will this
 * be back before my meeting" -- and a wall-clock time answers it without
 * arithmetic.
 *
 * Local time on purpose: the reader is in it. The date is only shown when it
 * is not obvious, because "16:42" is clearer than "22 Sep 16:42" when it is
 * already the 22nd.
 */
const TOKENS: Record<string, (d: Date) => string> = {
  YYYY: (d) => String(d.getFullYear()),
  YY: (d) => two(d.getFullYear() % 100),
  MMM: (d) => MONTHS[d.getMonth()]!,
  MM: (d) => two(d.getMonth() + 1),
  DDD: (d) => DAYS[d.getDay()]!,
  DD: (d) => two(d.getDate()),
  HH: (d) => two(d.getHours()),
  mm: (d) => two(d.getMinutes()),
  ss: (d) => two(d.getSeconds()),
}

// Longest first, so YYYY is not eaten by YY and MMM not by MM. One pass, so a
// digit produced by one token can never be re-read as another.
const TOKEN_RE = new RegExp(
  Object.keys(TOKENS)
    .sort((a, b) => b.length - a.length)
    .join("|"),
  "g",
)

/**
 * Render a moment with an explicit template: `DD/MM/YYYY HH:mm`.
 *
 * Case matters and follows the convention every date library uses: `MM` is the
 * month, `mm` the minute. Anything that is not a token is kept as written, so
 * separators are whatever the reader wants.
 */
export function formatStamp(at: Date, template: string): string {
  return template.replace(TOKEN_RE, (t) => TOKENS[t]!(at))
}

export function resetClock(
  epoch: number | undefined,
  now: number = Math.floor(Date.now() / 1000),
  template = "",
): string {
  if (epoch === undefined || epoch <= 0) return ""
  const at = new Date(epoch * 1000)
  // An explicit template wins outright. Someone who asked for a date every
  // time did not ask for it to be hidden when it happens to be today.
  if (template.trim() !== "") return formatStamp(at, template)
  const clock = `${two(at.getHours())}:${two(at.getMinutes())}`

  const midnight = new Date(now * 1000)
  midnight.setHours(0, 0, 0, 0)
  const days = Math.floor((at.getTime() - midnight.getTime()) / 86_400_000)

  if (days <= 0) return clock
  if (days === 1) return `tomorrow ${clock}`
  // Past a week a weekday is ambiguous -- "Mon" could be six days out or
  // thirteen -- so it becomes a date.
  if (days < 7) return `${DAYS[at.getDay()]} ${clock}`
  return `${at.getDate()} ${MONTHS[at.getMonth()]} ${clock}`
}

/** `5h resets 16:42 · wk resets Thu 02:00`, skipping what is not known. */
export function resetText(
  quota: QuotaCache,
  source: string | null,
  now: number = Math.floor(Date.now() / 1000),
  template = "",
): string {
  const q = source ? quota?.[source] : undefined
  const parts: string[] = []
  const five = resetClock(q?.fiveHour?.resetsAt, now, template)
  const week = resetClock(q?.sevenDay?.resetsAt, now, template)
  if (five) parts.push(`5h resets ${five}`)
  if (week) parts.push(`wk resets ${week}`)
  return parts.join(SEP)
}

export function buildPickerOptions(input: {
  accounts: ChipAccount[]
  presets: Record<string, { label?: string; strategy?: string }>
  quota: QuotaCache
  selection: string
  names?: Map<string, string>
  /** Unix seconds, injectable so a reset time can be asserted. */
  now?: number
  /** `DD/MM/YYYY HH:mm`, or "" for the relative style. */
  resetFormat?: string
}): PickerOption[] {
  // "active" PREFIXES rather than replaces: the reset times are why this row
  // is worth reading, and the selected account is the one most likely to be
  // read for them.
  const mark = (value: string, row: PickerOption): PickerOption =>
    input.selection === value
      ? {
          ...row,
          description: row.description
            ? `active${SEP}${row.description}`
            : "active",
        }
      : row

  const presets = Object.entries(input.presets).map(([name, p]) =>
    mark(`${PRESET}${name}`, {
      title: `${p.label ?? name}${p.strategy ? `${SEP}${p.strategy}` : ""}`,
      value: `${PRESET}${name}`,
      category: "Balancing",
    }),
  )

  const auto = mark(AUTO, {
    title: `Auto${SEP}balance across all`,
    value: AUTO,
    category: "Balancing",
  })

  const pickerNames = input.names ?? shortNames(input.accounts)
  const accounts = input.accounts.map((a) => {
    const load = `${SEP}${quotaText(input.quota, a.source, { includeWeek: false, spend: true })}`
    return mark(a.source, {
      title: `${pickerNames.get(a.source) ?? shortLabel(a.label)}${load}`,
      value: a.source,
      description: resetText(
        input.quota,
        a.source,
        input.now,
        input.resetFormat,
      ),
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
    const err = s.errors > 0 ? `${SEP}${s.errors} err` : ""
    const spread =
      s.accounts.length > 1 ? `${s.accounts.length} accounts` : "1 account"
    return {
      // The id is long and the tail is what distinguishes one from another.
      title: `${s.session.slice(-8)}${SEP}${s.requests} req${err}`,
      value: s.session,
      description: [
        spread,
        s.models.map(shortModel).join(", "),
        `avg ${fmtMs(s.avg_ms)}`,
        ago(s.last_at, now),
      ].join(SEP),
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
  names: Map<string, string> = shortNames(all),
): PickerOption[] {
  const enabled = new Set(enabledSources(all, allowList))
  return all.map((a) => {
    const state = enabled.has(a.source) ? "[x]" : "[ ]"
    const load = quotaText(quota, a.source, { spend: true })
    return {
      title: `${state} ${names.get(a.source) ?? a.source}`,
      value: a.source,
      description: `${load}${SEP}${shortLabel(a.label)}`,
    }
  })
}

/** Bytes, at the precision a reader can act on. */
export function fmtBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

/**
 * A rough token count from a byte count.
 *
 * Four bytes per token is the usual rule of thumb for English prose and holds
 * badly for code, JSON and non-Latin scripts -- which is most of what a system
 * prompt contains. It is marked "~" everywhere it is shown and is here because
 * a reader thinks in tokens; anyone needing the real number should read the
 * response usage, which this plugin does not record.
 */
export function approxTokens(bytes: number): string {
  const t = Math.round(bytes / 4)
  return t >= 1000 ? `~${Math.round(t / 1000)}k tok` : `~${t} tok`
}

/** What the capture file says about one session's prompts. */
export type ContextSummary = {
  captured: number
  avgBytes: number
  maxBytes: number
  systemBytes: number
  toolBytes: number
  messageBytes: number
  cachedBytes: number
}

export function contextSummary(
  shapes: {
    bytes: number
    systemBytes: number
    toolBytes: number
    messageBytes: number
    cachedBytes: number
  }[],
): ContextSummary | null {
  if (shapes.length === 0) return null
  const sum = (pick: (s: (typeof shapes)[number]) => number) =>
    shapes.reduce((n, sh) => n + pick(sh), 0)
  return {
    captured: shapes.length,
    avgBytes: Math.round(sum((sh) => sh.bytes) / shapes.length),
    maxBytes: Math.max(...shapes.map((sh) => sh.bytes)),
    // Averaged, not summed: the question is how big a request is, not how many
    // bytes crossed the wire in total.
    systemBytes: Math.round(sum((sh) => sh.systemBytes) / shapes.length),
    toolBytes: Math.round(sum((sh) => sh.toolBytes) / shapes.length),
    messageBytes: Math.round(sum((sh) => sh.messageBytes) / shapes.length),
    cachedBytes: Math.round(sum((sh) => sh.cachedBytes) / shapes.length),
  }
}

/**
 * The drill-down for one session, grouped.
 *
 * Rows are inert: this is a report rendered in a picker because a picker brings
 * scrolling and filtering, not because anything here is selectable.
 */
export function detailRows(
  d: SessionDetail,
  opts: {
    names?: Map<string, string>
    context?: ContextSummary | null
    now?: number
  } = {},
): PickerOption[] {
  const now = opts.now ?? Date.now()
  const name = (source: string) => opts.names?.get(source) ?? shortLabel(source)
  const rows: PickerOption[] = []
  const add = (category: string, title: string, description: string) =>
    rows.push({ title, value: `${category}:${title}`, description, category })

  const mins = Math.max(1, Math.round((d.last_at - d.first_at) / 60_000))
  add(
    "Traffic",
    `${d.requests} requests`,
    `over ${mins}m${SEP}${(d.requests / mins).toFixed(1)}/min${SEP}last ${ago(d.last_at, now)}`,
  )
  if (d.errors > 0) {
    add(
      "Traffic",
      `${d.errors} failed`,
      d.byStatus
        .filter((r) => r.status >= 400)
        .map((r) => `${r.count}x ${r.status}`)
        .join(SEP),
    )
  }
  add(
    "Traffic",
    `avg ${(d.avg_ms / 1000).toFixed(1)}s`,
    `slowest ${(d.max_ms / 1000).toFixed(1)}s`,
  )

  for (const a of d.byAccount) {
    const share = Math.round((a.requests / d.requests) * 100)
    add("Accounts", name(a.account), `${a.requests} requests${SEP}${share}%`)
  }
  for (const m of d.byModel) {
    add("Models", shortModel(m.model), `${m.requests} requests`)
  }

  for (const q of d.quotaMoves) {
    const from = Math.round(q.from * 100)
    const to = Math.round(q.to * 100)
    add(
      "Quota (5h)",
      `${name(q.account)}: ${from}% -> ${to}%`,
      // Said plainly: the window is shared, so this is an upper bound on what
      // this session did, never an attribution.
      `moved ${to - from > 0 ? "+" : ""}${to - from} points while this session ran${SEP}shared with other traffic`,
    )
  }

  const c = opts.context
  if (c) {
    add(
      "Context",
      `avg ${fmtBytes(c.avgBytes)}`,
      `${approxTokens(c.avgBytes)}${SEP}largest ${fmtBytes(c.maxBytes)}${SEP}from ${c.captured} captured`,
    )
    add(
      "Context",
      `system ${fmtBytes(c.systemBytes)}`,
      `${approxTokens(c.systemBytes)}${SEP}paid on every request`,
    )
    add(
      "Context",
      `tools ${fmtBytes(c.toolBytes)}`,
      `${approxTokens(c.toolBytes)}${SEP}paid on every request`,
    )
    add(
      "Context",
      `messages ${fmtBytes(c.messageBytes)}`,
      approxTokens(c.messageBytes),
    )
    if (c.cachedBytes > 0) {
      add(
        "Context",
        `cached ${fmtBytes(c.cachedBytes)}`,
        `${Math.round((c.cachedBytes / Math.max(1, c.avgBytes)) * 100)}% of an average request`,
      )
    }
  } else {
    add(
      "Context",
      "not recorded",
      `set captureRequests to shape or full, then reopen${SEP}nothing is captured by default`,
    )
  }

  return rows
}
