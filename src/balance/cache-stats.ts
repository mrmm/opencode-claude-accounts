/**
 * Cache efficiency, and why a miss happened.
 *
 * Prompt caching is where the money is: a cache read costs a twentieth of a
 * fresh input token, so a session that keeps its prefix warm is an order of
 * magnitude cheaper than one that rewrites it. The header utilisation cannot
 * see this — it counts tokens, not hits — so the only way to know the real hit
 * rate is to total the token counts the usage tap records.
 *
 * A pure reducer over a session's requests in order. `hitRate` is the share of
 * cacheable input that was served from cache; a miss is a request whose cache
 * write dwarfs its read, and each one is labelled with the most likely cause by
 * comparing it to the request before it (account, model, prefix hashes, gap).
 * No I/O, no clock — the caller supplies the rows already ordered.
 */

import { accountKey } from "./account-key.ts"

/** The minimum a request row needs to be classified. */
export type CacheRow = {
  at: number
  account: string
  model: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cacheWrite1h: number
  /** Cache TTL used, if known — decides the gap threshold for ttl-expired. */
  ttl?: "5m" | "1h"
  /** Hash of the system prompt prefix, from the request-shape log, if present. */
  systemSha?: string
  /** Hash of the tool set, from the request-shape log, if present. */
  toolsSha?: string
  /** The request carried a context-editing block. */
  contextEdited?: boolean
  /** OpenCode session, so misses are classified against the same session's previous request. */
  session?: string
}

export type MissCause =
  | "first-request"
  | "account-switch"
  | "model-change"
  | "ttl-expired"
  | "prefix-change"
  | "compaction"

export type Miss = {
  at: number
  cause: MissCause
  /** Cache-write tokens this miss paid for. */
  tokens: number
}

export type CacheStats = {
  /** cacheRead / (input + cacheRead + cacheWrite), 0 when nothing cacheable. */
  hitRate: number
  reads: number
  writes: number
  /** Uncached input tokens. */
  uncached: number
  misses: Miss[]
}

const TTL_MS: Record<"5m" | "1h", number> = {
  "5m": 5 * 60_000,
  "1h": 60 * 60_000,
}

/**
 * A request is a "miss" worth explaining when it paid to write cache that it
 * largely could not read back — i.e. its write is big relative to its read.
 * A fully warm request writes little and reads lots; this is the inverse.
 */
function isMiss(r: CacheRow): boolean {
  const write = r.cacheWrite + r.cacheWrite1h
  if (write === 0) return false
  return write > r.cacheRead
}

/**
 * Why this request could not reuse the previous one's cache.
 *
 * Ordered by how unambiguous the signal is: no predecessor, then a changed
 * account or model (the cache is per-account and per-model, so either guarantees
 * a cold prefix), then an expired TTL (idle longer than the write's lifetime),
 * then a changed prefix within a live TTL (same account/model but the system or
 * tools hash moved), and finally compaction — a prefix change that also shrank
 * the conversation, which is the one shape we can tell apart.
 */
function classify(r: CacheRow, prev: CacheRow | undefined): MissCause {
  if (!prev) return "first-request"
  if (accountKey(r.account) !== accountKey(prev.account))
    return "account-switch"
  if (r.model !== prev.model) return "model-change"

  const ttl = r.ttl ?? "5m"
  if (r.at - prev.at > TTL_MS[ttl]) return "ttl-expired"

  const prefixChanged =
    (r.systemSha !== undefined &&
      prev.systemSha !== undefined &&
      r.systemSha !== prev.systemSha) ||
    (r.toolsSha !== undefined &&
      prev.toolsSha !== undefined &&
      r.toolsSha !== prev.toolsSha)

  if (prefixChanged) {
    // A prefix change that also dropped input tokens is a compaction: the
    // conversation was summarised, so the cacheable head is both different and
    // smaller. Distinguishable from an ordinary edit, which grows or holds.
    const totalIn = r.input + r.cacheRead
    const prevIn = prev.input + prev.cacheRead
    if (totalIn < prevIn) return "compaction"
    return "prefix-change"
  }

  // Same account, model, prefix, within TTL, yet it still wrote more than it
  // read. Best explained as a prefix change we could not see (no shape hashes).
  return "prefix-change"
}

/**
 * Reduce a session's (or account's) ordered request rows to cache statistics.
 *
 * Rows MUST be in chronological order; classification compares each to the one
 * before it. Rows with no token data (all four fields 0) contribute nothing to
 * the totals and are never misses, so mixing in pre-telemetry rows is harmless.
 */
export function cacheStats(rows: readonly CacheRow[]): CacheStats {
  let reads = 0
  let writes = 0
  let uncached = 0
  const misses: Miss[] = []
  let prev: CacheRow | undefined

  for (const r of rows) {
    reads += r.cacheRead
    writes += r.cacheWrite + r.cacheWrite1h
    uncached += r.input

    const cacheable = r.input + r.cacheRead + r.cacheWrite + r.cacheWrite1h
    if (cacheable > 0 && isMiss(r)) {
      misses.push({
        at: r.at,
        cause: classify(r, prev),
        tokens: r.cacheWrite + r.cacheWrite1h,
      })
    }
    prev = r
  }

  const cacheable = uncached + reads + writes
  const hitRate = cacheable > 0 ? reads / cacheable : 0
  return { hitRate, reads, writes, uncached, misses }
}

/** What each optimisation did, measured over requests that carry token data. */
export type CacheImpact = CacheStats & {
  requests: number
  /** Input cost in fresh-input-token equivalents, as billed. */
  cost: number
  /** The same input at full price, with no cache at all. */
  noCache: number
  /** 1 - cost/noCache: the share of input cost caching saved. */
  saved: number
  byCause: Partial<Record<MissCause, { n: number; tokens: number }>>
  /** Requests sent with 1h cache markers, and the 1h write tokens they paid. */
  ttl1h: { requests: number; writes: number }
  /** Requests that carried a context-editing block. */
  contextEdited: number
}

// Anthropic multipliers on the input price: read 0.05x on Opus 5.x, 0.1x on
// the rest; 5m write 1.25x, 1h write 2x.
const readPrice = (model: string) => (model.includes("opus") ? 0.05 : 0.1)

/** cacheStats plus the money side: cost vs no cache, misses by cause, TTL and context-edit usage. */
export function cacheImpact(rows: readonly CacheRow[]): CacheImpact {
  const withTokens = rows.filter(
    (r) => r.input + r.cacheRead + r.cacheWrite + r.cacheWrite1h > 0,
  )
  const stats = cacheStats(withTokens)
  // Interleaved sessions would read as account switches; classify each alone.
  const bySession = new Map<string, CacheRow[]>()
  for (const r of withTokens) {
    const k = r.session ?? ""
    const arr = bySession.get(k)
    if (arr) arr.push(r)
    else bySession.set(k, [r])
  }
  stats.misses = [...bySession.values()]
    .flatMap((rs) => cacheStats(rs).misses)
    .sort((a, b) => a.at - b.at)
  let cost = 0
  let noCache = 0
  let ttlReqs = 0
  let ttlWrites = 0
  let edited = 0
  for (const r of withTokens) {
    cost +=
      r.input +
      readPrice(r.model) * r.cacheRead +
      1.25 * r.cacheWrite +
      2 * r.cacheWrite1h
    noCache += r.input + r.cacheRead + r.cacheWrite + r.cacheWrite1h
    if (r.ttl === "1h") ttlReqs++
    ttlWrites += r.cacheWrite1h
    if (r.contextEdited) edited++
  }
  const byCause: CacheImpact["byCause"] = {}
  for (const m of stats.misses) {
    const c = (byCause[m.cause] ??= { n: 0, tokens: 0 })
    c.n++
    c.tokens += m.tokens
  }
  return {
    ...stats,
    requests: withTokens.length,
    cost,
    noCache,
    saved: noCache > 0 ? 1 - cost / noCache : 0,
    byCause,
    ttl1h: { requests: ttlReqs, writes: ttlWrites },
    contextEdited: edited,
  }
}

/** Plain-language names for miss causes, shared by every surface. */
export const MISS_CAUSE_LABEL: Record<MissCause, string> = {
  "first-request": "first request",
  "account-switch": "account switch",
  "model-change": "model change",
  "ttl-expired": "TTL expired",
  "prefix-change": "prefix change",
  compaction: "compaction",
}

/** One bucket of a breakdown: the headline figures, without the per-miss list. */
export type CacheSummary = {
  requests: number
  /** Share of cacheable input served from cache. */
  hitRate: number
  /** Share of input cost caching saved, 1 - cost/noCache. */
  saved: number
  misses: number
  byCause: Partial<Record<MissCause, { n: number; tokens: number }>>
}

export type CacheBreakdown = {
  global: CacheSummary
  /** Keyed by account id (see `keyOf`), most requests first. */
  accounts: (CacheSummary & { account: string })[]
  /** Most misses first. */
  sessions: (CacheSummary & { session: string })[]
}

type Acc = {
  requests: number
  reads: number
  writes: number
  uncached: number
  cost: number
  noCache: number
  byCause: CacheSummary["byCause"]
}

const emptyAcc = (): Acc => ({
  requests: 0,
  reads: 0,
  writes: 0,
  uncached: 0,
  cost: 0,
  noCache: 0,
  byCause: {},
})

const summarise = (a: Acc): CacheSummary => {
  const cacheable = a.uncached + a.reads + a.writes
  return {
    requests: a.requests,
    hitRate: cacheable > 0 ? a.reads / cacheable : 0,
    saved: a.noCache > 0 ? 1 - a.cost / a.noCache : 0,
    misses: Object.values(a.byCause).reduce((n, c) => n + (c?.n ?? 0), 0),
    byCause: a.byCause,
  }
}

/**
 * The same figures as cacheImpact, split three ways: overall, per account and
 * per session. One pass; each miss is classified against the previous request
 * of its own session (so an account switch is seen) and charged to the account
 * and session of the request that missed. Accounts are bucketed by `keyOf`,
 * which defaults to `accountKey` so a source and its id land together.
 */
export function cacheBreakdown(
  rows: readonly CacheRow[],
  keyOf: (account: string) => string = accountKey,
): CacheBreakdown {
  const global = emptyAcc()
  const byAccount = new Map<string, Acc>()
  const bySession = new Map<string, Acc>()
  const prevOf = new Map<string, CacheRow>()
  const keys = new Map<string, string>()
  const key = (a: string) => {
    let k = keys.get(a)
    if (k === undefined) keys.set(a, (k = keyOf(a)))
    return k
  }
  const bucket = (m: Map<string, Acc>, k: string) => {
    let a = m.get(k)
    if (!a) m.set(k, (a = emptyAcc()))
    return a
  }
  const sorted = [...rows].sort((a, b) => a.at - b.at)
  for (const r of sorted) {
    const write = r.cacheWrite + r.cacheWrite1h
    if (r.input + r.cacheRead + write === 0) continue
    const account = key(r.account)
    const session = r.session ?? ""
    const prev = prevOf.get(session)
    prevOf.set(session, r)
    const cause = isMiss(r) ? classify(r, prev) : undefined
    for (const acc of [
      global,
      bucket(byAccount, account),
      bucket(bySession, session),
    ]) {
      acc.requests++
      acc.reads += r.cacheRead
      acc.writes += write
      acc.uncached += r.input
      acc.cost +=
        r.input +
        readPrice(r.model) * r.cacheRead +
        1.25 * r.cacheWrite +
        2 * r.cacheWrite1h
      acc.noCache += r.input + r.cacheRead + write
      if (cause) {
        const c = (acc.byCause[cause] ??= { n: 0, tokens: 0 })
        c.n++
        c.tokens += write
      }
    }
  }
  return {
    global: summarise(global),
    accounts: [...byAccount]
      .map(([account, a]) => Object.assign(summarise(a), { account }))
      .sort((a, b) => b.requests - a.requests),
    sessions: [...bySession]
      .filter(([session]) => session !== "")
      .map(([session, a]) => Object.assign(summarise(a), { session }))
      .sort((a, b) => b.misses - a.misses || b.requests - a.requests),
  }
}

/** The cause that cost the most rewritten tokens, or undefined when nothing missed. */
export function topCause(
  s: Pick<CacheSummary, "byCause">,
): MissCause | undefined {
  return (Object.entries(s.byCause) as [MissCause, { tokens: number }][]).sort(
    (a, b) => b[1].tokens - a[1].tokens,
  )[0]?.[0]
}
