/**
 * The TUI's view of usage ceilings, cache efficiency and ranked advice.
 *
 * Pure on purpose, the same contract as chip.ts and forecast.ts: the entry
 * point reads files and renders what these return, so the part that can be
 * wrong is the part that is covered. Nothing here reads a clock, a file or the
 * network — every input arrives as an argument.
 *
 * Why a new module rather than more of chip.ts: these are caps/cache/advice
 * facts, not "what the chip says about the active account", and chip.ts is
 * already the largest fork-owned surface. Keeping them apart is what lets the
 * ceiling bar and the cache view be tested without the picker's machinery.
 */
import type {
  CacheImpact,
  CacheRow,
  CacheStats,
  MissCause,
} from "../balance/index.ts"
import { cacheStats } from "../balance/index.ts"
import { SEP } from "./chip.ts"
import { si, type Row } from "./tokens.ts"

/** The visible text of a palette command: `Claude › <Area> › <Verb object>`. */
export const AREA_SEP = " \u203a " // › with spaces

export type Area =
  | "Accounts"
  | "Presets"
  | "Usage"
  | "Cache"
  | "Optimize"
  | "Diagnostics"
  | "Settings"

/** `Claude › Accounts › Manage accounts`. One speller, so every title agrees. */
export function paletteTitle(area: Area, verb: string): string {
  return `Claude${AREA_SEP}${area}${AREA_SEP}${verb}`
}

/**
 * A toast that names the thing, the outcome and the reason, as D10 asks:
 * `Preset rr-12 not saved: name already used`. The reason is dropped when
 * absent so a bare `Account enabled` still reads.
 */
export function toastResult(
  thing: string,
  result: string,
  reason?: string,
): string {
  const head = `${thing} ${result}`.trim()
  return reason ? `${head}: ${reason}` : head
}

// ---------------------------------------------------------------------------
// Ceilings
// ---------------------------------------------------------------------------

export type CapWindow = "5h" | "7d"

/** One account's state against one window's ceiling, everything already resolved. */
export type CeilingView = {
  /** Current utilisation, fraction 0..1, or undefined when nothing was read. */
  used?: number
  /** The ceiling the operator set, fraction 0..1. 1 means no ceiling. */
  ceiling: number
  /** True when `used` has reached the ceiling: the account is held in reserve. */
  reserved: boolean
}

export function ceilingView(
  used: number | undefined,
  ceiling: number,
): CeilingView {
  const c = ceiling > 0 && ceiling <= 1 ? ceiling : 1
  return {
    used,
    ceiling: c,
    reserved: used !== undefined && c < 1 && used >= c,
  }
}

/**
 * A text bar of `width` cells: filled to `used`, with a `┊` marker at the
 * ceiling when one is set below the full window. Reads `███░┊░░` — the marker
 * sits where the pool stops drawing and the reserve begins.
 *
 * A reserved account (used at or past the ceiling) fills up to the marker and
 * no further, since past it the account is not the pool's to spend.
 */
export function ceilingBar(v: CeilingView, width = 10): string {
  const cells = Array.from({ length: width }, () => "\u2591") // ░
  const used = v.used ?? 0
  const fill = Math.round(Math.min(used, 1) * width)
  for (let i = 0; i < fill && i < width; i++) cells[i] = "\u2588" // █
  if (v.ceiling < 1) {
    // One cell in from where the ceiling lands, so a full bar still shows it.
    const at = Math.min(width - 1, Math.round(v.ceiling * width))
    cells[at] = "\u250a" // ┊
  }
  return cells.join("")
}

/** `62%/80%` used-over-ceiling, or `62%` when there is no ceiling. */
export function ceilingPct(v: CeilingView): string {
  const u = v.used === undefined ? "\u2014" : `${Math.round(v.used * 100)}%`
  return v.ceiling < 1 ? `${u}/${Math.round(v.ceiling * 100)}%` : u
}

/**
 * One account row for Manage accounts: id first, then display name, then each
 * window's bar. `id` is the account key (stable id, or source when un-migrated);
 * `name` is the human label. Both are shown because the id keys the config a
 * person edits and the name is what they call it.
 */
export function accountCapRow(input: {
  id: string
  name: string
  enabled: boolean
  five: CeilingView
  week: CeilingView
  capMode?: "soft" | "hard"
  reserveInUse?: boolean
}): Row {
  const state = input.enabled ? "[x]" : "[ ]"
  const parts = [
    `5h ${ceilingBar(input.five)} ${ceilingPct(input.five)}`,
    `wk ${ceilingPct(input.week)}`,
  ]
  if (input.five.reserved || input.week.reserved) {
    const mode = input.capMode === "hard" ? "reserved (hard)" : "reserved"
    parts.push(input.reserveInUse ? `${mode} \u00b7 in use` : mode)
  }
  return {
    label: `${state} ${input.id}`,
    value: `${input.name}${SEP}${parts.join(SEP)}`,
    level: input.five.reserved || input.week.reserved ? "warn" : "ok",
  }
}

// ---------------------------------------------------------------------------
// Cache view (goal 5)
// ---------------------------------------------------------------------------

/** The minimum a usage-log request carries, so this file never imports usage.ts. */
export type RequestLike = {
  account: string
  model: string
  created_at: number
  session?: string
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  cacheWrite1h?: number
  ttl?: "5m" | "1h"
  contextEdited?: boolean
}

/** A shape-log entry, joined by session+time to give a request its prefix hashes. */
export type ShapeLike = {
  sessionId: string | null
  created_at: number
  systemSha?: string
  toolsSha?: string
}

/**
 * Turn usage-log requests into the rows cacheStats classifies, joining each to
 * the nearest shape-log entry of the same session within a small window so a
 * prefix change can be told from a TTL expiry. Rows come back in time order.
 */
export function toCacheRows(
  requests: readonly RequestLike[],
  shapes: readonly ShapeLike[] = [],
  joinMs = 2_000,
): CacheRow[] {
  const bySession = new Map<string, ShapeLike[]>()
  for (const s of shapes) {
    if (!s.sessionId) continue
    const arr = bySession.get(s.sessionId) ?? []
    arr.push(s)
    bySession.set(s.sessionId, arr)
  }
  const nearest = (r: RequestLike): ShapeLike | undefined => {
    if (!r.session) return undefined
    let best: ShapeLike | undefined
    let bestGap = joinMs
    for (const s of bySession.get(r.session) ?? []) {
      const gap = Math.abs(s.created_at - r.created_at)
      if (gap <= bestGap) {
        bestGap = gap
        best = s
      }
    }
    return best
  }
  return [...requests]
    .sort((a, b) => a.created_at - b.created_at)
    .map((r) => {
      const sh = nearest(r)
      return {
        at: r.created_at,
        account: r.account,
        model: r.model,
        input: r.input ?? 0,
        output: r.output ?? 0,
        cacheRead: r.cacheRead ?? 0,
        cacheWrite: r.cacheWrite ?? 0,
        cacheWrite1h: r.cacheWrite1h ?? 0,
        systemSha: sh?.systemSha,
        toolsSha: sh?.toolsSha,
        ...(r.session ? { session: r.session } : {}),
        ...(r.ttl ? { ttl: r.ttl } : {}),
        ...(r.contextEdited ? { contextEdited: true } : {}),
      }
    })
}

const CAUSE_LABEL: Record<MissCause, string> = {
  "first-request": "first request",
  "account-switch": "account switch",
  "model-change": "model change",
  "ttl-expired": "TTL expired",
  "prefix-change": "prefix change",
  compaction: "compaction",
}

/** `78% hit · 1.2M read · 240k write · 90k uncached`, plus the top miss causes. */
export function cacheSummaryRows(stats: CacheStats, lastN = 5): Row[] {
  const rows: Row[] = [
    {
      label: "hit rate",
      value: `${Math.round(stats.hitRate * 100)}%`,
      level: stats.hitRate < 0.6 ? "warn" : "ok",
    },
    {
      label: "tokens",
      value: `${si(stats.reads)} read${SEP}${si(stats.writes)} write${SEP}${si(stats.uncached)} uncached`,
    },
  ]
  const byCause = new Map<MissCause, { count: number; tokens: number }>()
  for (const m of stats.misses) {
    const e = byCause.get(m.cause) ?? { count: 0, tokens: 0 }
    e.count += 1
    e.tokens += m.tokens
    byCause.set(m.cause, e)
  }
  const causes = [...byCause.entries()]
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .slice(0, lastN)
  for (const [cause, e] of causes) {
    rows.push({
      label: CAUSE_LABEL[cause],
      value: `${e.count}\u00d7${SEP}~${si(e.tokens)} rewritten`,
      level:
        cause === "account-switch" || cause === "ttl-expired" ? "warn" : "ok",
    })
  }
  if (stats.misses.length === 0) {
    rows.push({ label: "misses", value: "none recorded", level: "ok" })
  }
  return rows
}

/** Per-account and per-session cache rows, each its own labelled block. */
export function cacheViewRows(
  requests: readonly RequestLike[],
  shapes: readonly ShapeLike[] = [],
  names: Map<string, string> = new Map(),
): { title: string; rows: Row[] }[] {
  const out: { title: string; rows: Row[] }[] = []
  const rows = toCacheRows(requests, shapes)

  out.push({ title: "All accounts", rows: cacheSummaryRows(cacheStats(rows)) })

  // Per account.
  const byAccount = new Map<string, CacheRow[]>()
  for (const r of rows) {
    const arr = byAccount.get(r.account) ?? []
    arr.push(r)
    byAccount.set(r.account, arr)
  }
  for (const [account, rs] of [...byAccount.entries()].sort()) {
    out.push({
      title: `Account ${names.get(account) ?? account}`,
      rows: cacheSummaryRows(cacheStats(rs)),
    })
  }

  // Per session, keyed off the original request list.
  const bySession = new Map<string, RequestLike[]>()
  for (const req of requests) {
    if (!req.session) continue
    const arr = bySession.get(req.session) ?? []
    arr.push(req)
    bySession.set(req.session, arr)
  }
  for (const [session, reqs] of bySession.entries()) {
    out.push({
      title: `Session ${session.slice(-8)}`,
      rows: cacheSummaryRows(cacheStats(toCacheRows(reqs, shapes))),
    })
  }

  return out
}

/** The settings the impact view lets you change, in the order shown. */
export const OPTIMIZATION_KEYS = [
  "cacheTtl",
  "contextEditing",
  "bindBy",
  "strategy",
  "capMode",
] as const

export type OptimizationRow = Row & { setting?: string }

const pct = (n: number) => `${Math.round(n * 100)}%`

/**
 * Each optimisation's setting next to what it measurably did.
 *
 * Headline rows first (hit rate, share of input cost saved, misses by cause),
 * then one row per editable setting carrying `setting` so the dialog can open
 * its editor. Value strings say what the data shows, not what the knob means.
 */
export function optimizationRows(
  impact: CacheImpact,
  settings: Record<string, unknown>,
): OptimizationRow[] {
  const rows: OptimizationRow[] = [
    {
      label: "caching",
      value:
        impact.requests === 0
          ? "no requests with token data yet"
          : `${pct(impact.hitRate)} hit${SEP}saves ${pct(impact.saved)} of input cost${SEP}${impact.requests} req`,
      level: impact.requests > 0 && impact.hitRate < 0.6 ? "warn" : "ok",
    },
  ]
  const causes = Object.entries(impact.byCause).sort(
    (a, b) => b[1].tokens - a[1].tokens,
  )
  for (const [cause, e] of causes) {
    const share = impact.cost > 0 ? (1.25 * e.tokens) / impact.cost : 0
    rows.push({
      label: `miss: ${CAUSE_LABEL[cause as MissCause]}`,
      value: `${e.n}\u00d7${SEP}~${si(e.tokens)} rewritten${SEP}~${pct(share)} of cost`,
      level:
        cause === "account-switch" || cause === "ttl-expired" ? "warn" : "ok",
    })
  }
  const ttlMisses = impact.byCause["ttl-expired"]?.n ?? 0
  const switchMisses = impact.byCause["account-switch"]?.n ?? 0
  const measured: Record<string, string> = {
    cacheTtl:
      `1h on ${impact.ttl1h.requests}/${impact.requests} req${SEP}${si(impact.ttl1h.writes)} 1h writes` +
      (ttlMisses > 0 && settings.cacheTtl === "5m"
        ? `${SEP}${ttlMisses} TTL misses: try auto`
        : ""),
    contextEditing: `applied on ${impact.contextEdited}/${impact.requests} req`,
    bindBy:
      `${switchMisses} account-switch misses` +
      (switchMisses > 0 && settings.bindBy !== "session"
        ? `${SEP}try session`
        : ""),
    strategy: `${switchMisses} account-switch misses`,
    capMode: "decides whether reserved quota can serve",
  }
  for (const key of OPTIMIZATION_KEYS) {
    const v = settings[key]
    const shown =
      typeof v === "object" && v !== null ? "on (custom)" : String(v ?? "-")
    rows.push({
      label: `${key} = ${shown}`,
      value: measured[key] ?? "",
      setting: key,
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// Ranked advice (goal 6)
// ---------------------------------------------------------------------------

/**
 * The documented price multipliers, as fractions of a fresh input token.
 *
 *  - A cache READ costs 0.05× on Opus 5.5, 0.1× on the rest — so re-reading a
 *    warm prefix is nearly free, and a miss that rewrites it is not.
 *  - A 5-minute cache WRITE costs 1.25×, a 1-hour write 2×.
 *
 * Savings are expressed in "input-token equivalents per day" so advice of
 * different kinds can be compared on one axis: the money is a function of
 * tokens, and the binding window is a function of tokens, so tokens is the axis
 * both reduce to.
 */
export const PRICE = {
  cacheRead: { opus: 0.05, other: 0.1 },
  write5m: 1.25,
  write1h: 2,
} as const

export type Advice = {
  /** What to change. */
  label: string
  /** Why, with the measured number. */
  value: string
  /** Input-token-equivalents saved per day if acted on. Ranks the list. */
  savedPerDay: number
  /** Share of the binding window that is, 0..1, when a quota is known. */
  windowShare?: number
  level: "ok" | "warn" | "critical"
}

/** Measured inputs the ranking reads; all already totalled by the caller. */
export type AdviceInput = {
  /** Cache stats over the span, from cacheStats. */
  cache: CacheStats
  /** Days the stats cover, for the per-day rate. At least a fraction. */
  spanDays: number
  /** Is the binding model Opus 5.5? Decides the cache-read multiplier. */
  opus?: boolean
  /** Tokens in the instruction block re-sent on every miss, if known. */
  instructionTokens?: number
  /** Tokens in the tool list re-sent on every miss, if known. */
  toolTokens?: number
  /** Average context size in tokens, and the editing trigger, when both known. */
  avgContext?: number
  contextTrigger?: number
  contextEditingOn?: boolean
  /** Daily token budget of the binding window, so a saving reads as a % of it. */
  windowTokens?: number
}

const perDay = (total: number, days: number) => total / Math.max(days, 1 / 24)

/**
 * Advice ranked by quota impact, highest first — the 80/20 of where the tokens
 * go. Each item carries the tokens it would save per day and that as a share of
 * the binding window, so "do this first" is a number and not a hunch.
 */
export function rankedAdvice(input: AdviceInput): Advice[] {
  const out: Advice[] = []
  const share = (perDayTokens: number) =>
    input.windowTokens && input.windowTokens > 0
      ? perDayTokens / input.windowTokens
      : undefined
  const add = (
    label: string,
    value: string,
    savedTotal: number,
    level: Advice["level"] = "warn",
  ) => {
    const savedPerDay = perDay(savedTotal, input.spanDays)
    out.push({
      label,
      value,
      savedPerDay,
      windowShare: share(savedPerDay),
      level,
    })
  }

  const writeCost = (tokens: number, oneHour = false) =>
    tokens * (oneHour ? PRICE.write1h : PRICE.write5m)

  // Misses grouped by cause: the rewrite tokens are what each cause actually
  // costs, priced as cache writes.
  const byCause = new Map<MissCause, { count: number; tokens: number }>()
  for (const m of input.cache.misses) {
    const e = byCause.get(m.cause) ?? { count: 0, tokens: 0 }
    e.count += 1
    e.tokens += m.tokens
    byCause.set(m.cause, e)
  }

  const switches = byCause.get("account-switch")
  if (switches && switches.count > 0) {
    add(
      "account switches",
      `${switches.count}\u00d7 caused ~${si(switches.tokens)} rewritten \u2192 keep sticky/bindBy session`,
      writeCost(switches.tokens),
    )
  }
  const ttl = byCause.get("ttl-expired")
  if (ttl && ttl.count > 0) {
    add(
      "TTL expiry",
      `${ttl.count}\u00d7 idle past the cache window \u2192 cacheTtl 1h/auto`,
      writeCost(ttl.tokens),
    )
  }

  // Instructions and tools: re-sent as a cache write on every miss, so their
  // cost scales with the miss count, not the session count.
  const missCount = input.cache.misses.length
  if (
    input.instructionTokens &&
    input.instructionTokens > 5_000 &&
    missCount > 0
  ) {
    add(
      "instructions",
      `~${si(input.instructionTokens)} re-sent at each of ${missCount} misses \u2192 trim`,
      writeCost(input.instructionTokens * missCount),
    )
  }
  if (input.toolTokens && input.toolTokens > 2_500 && missCount > 0) {
    add(
      "tool list",
      `~${si(input.toolTokens)} per miss \u2192 disable unused MCP`,
      writeCost(input.toolTokens * missCount),
    )
  }

  if (
    input.contextEditingOn === false &&
    input.avgContext !== undefined &&
    input.contextTrigger !== undefined &&
    input.avgContext > input.contextTrigger
  ) {
    // Context editing drops old tool output, so the saving is the slice above
    // the trigger, paid as a read on every request it would have been cached.
    const over = input.avgContext - input.contextTrigger
    add(
      "context editing",
      `avg context ~${si(input.avgContext)} over the ${si(input.contextTrigger)} trigger \u2192 consider enabling`,
      over * (input.opus ? PRICE.cacheRead.opus : PRICE.cacheRead.other),
      "ok",
    )
  }

  return out.sort((a, b) => b.savedPerDay - a.savedPerDay)
}

/** Advice as sidebar rows, each stamped with what it saves. */
export function adviceRows(advice: readonly Advice[]): Row[] {
  if (advice.length === 0)
    return [
      { label: "optimize", value: "\u2713 nothing stands out", level: "ok" },
    ]
  return advice.map((a) => {
    const share =
      a.windowShare !== undefined
        ? ` (${Math.round(a.windowShare * 100)}% of window/day)`
        : ""
    return {
      label: a.label,
      value: `${a.value}${SEP}~${si(Math.round(a.savedPerDay))}/day${share}`,
      level: a.level,
    }
  })
}

// ---------------------------------------------------------------------------
// Migration preview (goal 7)
// ---------------------------------------------------------------------------

/** One proposed id assignment, shown before any write. */
export function migrationPreviewRows(
  suggestions: readonly { source: string; id: string }[],
  names: Map<string, string> = new Map(),
): Row[] {
  if (suggestions.length === 0)
    return [
      { label: "ids", value: "every account already has one", level: "ok" },
    ]
  return suggestions.map((s) => ({
    label: names.get(s.source) ?? s.source.slice(-8),
    value: `\u2192 ${s.id}`,
    level: "ok",
  }))
}

// ---------------------------------------------------------------------------
// Optimize sidebar
// ---------------------------------------------------------------------------

/** 120k, 1.2M: whole thousands read faster in a narrow column than 120.0k. */
const short = (n: number) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(1)}M`
    : n >= 1e3
      ? `${Math.round(n / 1e3)}k`
      : String(Math.round(n))

/** Plain words for the hint labels, which are terse internal names. */
const HINT_WORDS: Record<string, string> = {
  duplicate: "duplicate file",
  instructions: "rules/AGENTS",
  injected: "reminders",
  schema: "tool schemas",
  context: "context",
  cache: "cache",
  "re-reads": "tool output",
  subagents: "subagents",
}

export type OptimizeSidebarInput = {
  session: {
    turns: number
    cost: number
    lastContext: number
    input: number
    cacheRead: number
    cacheWrite: number
  }
  /** This session's request rows priced by cacheImpact, when the usage log has them. */
  cache?: Pick<CacheImpact, "requests" | "saved" | "byCause">
  composition?: {
    fixed: number
    instructions: number
    tools: number
    injected: number
  }
  hints: readonly Row[]
  /** Model context window; 0 when unknown. */
  contextLimit: number
}

/**
 * The Optimize section as four plain answers and the next fix.
 *
 * spent / cache / context / re-sent each say what the number means (reused,
 * of the window, each turn), and colour only when it needs action. Hints keep
 * their ranking but get readable names.
 */
export function optimizeSidebarRows(i: OptimizeSidebarInput): Row[] {
  const s = i.session
  if (s.turns === 0) return [{ label: "session", value: "no turns yet" }]
  const rows: Row[] = [
    {
      label: "spent",
      value: `$${s.cost.toFixed(2)} over ${s.turns} turn${s.turns === 1 ? "" : "s"}`,
    },
  ]

  const read = s.input + s.cacheRead + s.cacheWrite
  if (read > 0) {
    const reused = s.cacheRead / read
    const saved =
      i.cache && i.cache.requests > 0
        ? `${SEP}input cost ${pct(i.cache.saved)} lower`
        : ""
    rows.push({
      label: "cache",
      value: `${pct(reused)} reused${saved}`,
      level: reused < 0.8 ? "warn" : "ok",
    })
    const causes = Object.entries(i.cache?.byCause ?? {})
      .filter(([c]) => c !== "first-request")
      .sort((a, b) => b[1].tokens - a[1].tokens)
    if (causes.length > 0) {
      const n = causes.reduce((t, [, v]) => t + v.n, 0)
      rows.push({
        label: "cache miss",
        value: `${n}\u00d7, mostly ${CAUSE_LABEL[causes[0]![0] as MissCause]}`,
        level: "warn",
      })
    }
  }

  const ctx = s.lastContext
  rows.push({
    label: "context",
    value:
      i.contextLimit > 0
        ? `${short(ctx)} of ${short(i.contextLimit)} (${pct(ctx / i.contextLimit)})`
        : `${short(ctx)}${ctx > 150_000 ? ", compact now" : ""}`,
    level:
      ctx > 150_000 || (i.contextLimit > 0 && ctx / i.contextLimit > 0.75)
        ? "warn"
        : "ok",
  })

  const c = i.composition
  if (c && c.fixed > 0) {
    const parts = [
      c.instructions > 0 ? `rules ${short(c.instructions)}` : "",
      c.tools > 0 ? `tools ${short(c.tools)}` : "",
    ].filter(Boolean)
    rows.push({
      label: "re-sent",
      value: `${short(c.fixed)} each turn${parts.length ? ` (${parts.join(", ")})` : ""}`,
    })
  }

  const fixes = i.hints.filter((h) => h.level && h.level !== "ok").slice(0, 2)
  fixes.forEach((h, n) =>
    rows.push({
      label: n === 0 ? "fix next" : "then",
      value: `${HINT_WORDS[h.label] ?? h.label.trim()}: ${h.value}`,
      level: h.level,
    }),
  )
  if (fixes.length === 0)
    rows.push({ label: "fix next", value: "nothing stands out", level: "ok" })
  return rows
}
