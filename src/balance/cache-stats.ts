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
