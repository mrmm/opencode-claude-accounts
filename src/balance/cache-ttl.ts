/**
 * Cache-control TTL rewriting.
 *
 * OpenCode marks the cacheable prefix of a request with `cache_control`
 * breakpoints, defaulting to the 5-minute TTL. A 1-hour write costs more (2x vs
 * 1.25x) but survives a longer idle gap, so for a session that pauses -- waiting
 * on a permission prompt, a long tool call, a human -- the longer write pays for
 * itself by turning what would be a cold-cache miss into a read.
 *
 * This is a pure rewrite over the outgoing JSON body string: it finds the
 * `cache_control` markers the request already carries (on tools, system and
 * messages) and sets their `ttl`. It never ADDS a marker -- placement is
 * OpenCode's decision -- it only relabels the ones that are there.
 *
 * The one API rule it must respect: within a request, a 1-hour breakpoint must
 * appear before any 5-minute one. Rather than reason about order, setting "1h"
 * sets EVERY marker to 1h, which satisfies the rule unconditionally. The auto
 * decision is split out and pure: index.ts owns the per-session timing it reads.
 */

import type { CacheTtl } from "../config.ts"

/** The TTL actually applied to a body: a concrete window, or leave untouched. */
export type ResolvedTtl = "5m" | "1h" | "leave"

/** Idle gap past which "auto" lifts to 1h: a pause worth paying to survive. */
export const AUTO_GAP_MS = 4 * 60_000
/** Session age past which "auto" lifts to 1h: a long conversation keeps its head warm. */
export const AUTO_AGE_MS = 10 * 60_000

/**
 * Resolve "auto" to a concrete action from the session's timing. 1h when the
 * gap since the previous request is long, or the session itself is old; else
 * leave the body's own markers alone. A fixed "5m"/"1h" passes straight
 * through; only "auto" consults the clock.
 */
export function resolveTtl(
  ttl: CacheTtl,
  opts: {
    nowMs: number
    /** Epoch ms of this session's previous request, if any. */
    prevRequestAt?: number
    /** Epoch ms this session was first seen, if known. */
    sessionStartedAt?: number
  },
): ResolvedTtl {
  if (ttl === "5m") return "leave"
  if (ttl === "1h") return "1h"
  const gap =
    opts.prevRequestAt !== undefined ? opts.nowMs - opts.prevRequestAt : 0
  const age =
    opts.sessionStartedAt !== undefined ? opts.nowMs - opts.sessionStartedAt : 0
  return gap > AUTO_GAP_MS || age > AUTO_AGE_MS ? "1h" : "leave"
}

/**
 * Set the ttl on every `cache_control` marker in the body, leaving everything
 * else byte-for-byte. Walks tools, system and messages -- the three places a
 * marker can sit -- and never adds one. A "leave" is a no-op; an unparseable
 * body is returned unchanged, because this runs on the request path.
 */
export function applyCacheTtl(body: string, ttl: ResolvedTtl): string {
  if (ttl === "leave") return body
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }
  return setCacheTtl(parsed, ttl) ? JSON.stringify(parsed) : body
}

/**
 * `applyCacheTtl` on an already-parsed body, in place. True when at least one
 * marker was set -- the only case in which the ttl was actually sent.
 */
export function setCacheTtl(parsed: unknown, ttl: ResolvedTtl): boolean {
  if (ttl === "leave" || !parsed || typeof parsed !== "object") return false

  let touched = false
  const setMarker = (node: unknown): void => {
    if (!node || typeof node !== "object") return
    const cc = (node as Record<string, unknown>).cache_control
    if (cc && typeof cc === "object") {
      ;(cc as Record<string, unknown>).ttl = ttl
      touched = true
    }
  }

  const walkContent = (content: unknown): void => {
    if (typeof content === "string") return
    if (!Array.isArray(content)) return
    for (const block of content) setMarker(block)
  }

  const p = parsed as {
    tools?: unknown[]
    system?: unknown
    messages?: Array<{ content?: unknown }>
  }
  if (Array.isArray(p.tools)) for (const t of p.tools) setMarker(t)
  walkContent(p.system)
  if (Array.isArray(p.messages)) {
    for (const m of p.messages) walkContent(m?.content)
  }

  return touched
}
