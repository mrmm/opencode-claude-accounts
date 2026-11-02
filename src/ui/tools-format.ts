/**
 * The parts of the tools that are just logic.
 *
 * Split out from tools.ts because that module statically imports
 * @opencode-ai/plugin for its `tool()` helper, and anything importing it drags
 * the SDK into the module graph — which silently cancels node:test subtests.
 * Keeping the decisions here means they can be asserted; tools.ts is left as
 * thin glue between those decisions and the SDK.
 */

import {
  MISS_CAUSE_LABEL,
  topCause,
  type CacheBreakdown,
  type CacheSummary,
} from "../balance/cache-stats.ts"

export type SelectionKind =
  | { kind: "none" }
  | { kind: "auto" }
  | { kind: "preset"; name: string; known: boolean }
  | { kind: "pin"; source: string }

export const AUTO = "__auto__"
export const PRESET = "preset:"

export function classifySelection(
  value: string | null,
  knownPresets: readonly string[],
): SelectionKind {
  if (!value) return { kind: "none" }
  if (value === AUTO) return { kind: "auto" }
  if (value.startsWith(PRESET)) {
    const name = value.slice(PRESET.length)
    return { kind: "preset", name, known: knownPresets.includes(name) }
  }
  return { kind: "pin", source: value }
}

/**
 * Parse a window like "24h". Anything unrecognised falls back rather than
 * throwing: a malformed argument from a model should produce a sane report, not
 * an error the model then has to reason about.
 */
export function parseWindowMs(
  spec: string | undefined,
  fallback = "24h",
): number {
  const units: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  }
  const use = spec && /^\d+[smhd]$/.test(spec) ? spec : fallback
  const n = Number.parseInt(use, 10)
  const unit = units[use.slice(-1)] ?? units.h!
  return n * unit
}

/**
 * Why the model may not set the reserved-quota override, or undefined when it
 * may. Turning it off is always allowed: it only ever reduces spend.
 */
export function reserveRefusal(
  state: "on" | "off",
  agentReserve: boolean,
): string | undefined {
  if (state === "off" || agentReserve) return undefined
  return "Refused: spending reserved quota needs the operator. Turn it on from the TUI (This session > Use reserved quota), or set agentReserve: true in the config to let the agent do it."
}

/**
 * Per-account cache lines for claude_auth_status, in `order` (account ids as
 * configured), then any account seen in the log but not configured.
 */
export function cacheAccountLines(
  b: CacheBreakdown,
  order: readonly string[],
  name: (id: string) => string = (id) => id,
): string[] {
  const rank = (id: string) => {
    const i = order.indexOf(id)
    return i === -1 ? order.length : i
  }
  return [...b.accounts]
    .sort((x, y) => rank(x.account) - rank(y.account))
    .map(
      (a) =>
        `  ${a.account.padEnd(16)} ${name(a.account).padEnd(24)} ${cacheLine(a)}`,
    )
}

/** The `n` sessions with the most misses, by the last 8 characters of their id. */
export function cacheSessionLines(b: CacheBreakdown, n = 3): string[] {
  return b.sessions
    .filter((s) => s.misses > 0)
    .slice(0, n)
    .map((s) => `  …${s.session.slice(-8).padEnd(9)} ${cacheLine(s)}`)
}

/** `92% reused · input cost 81% lower · 120 req · 4 misses, mostly account switch` */
export function cacheLine(s: CacheSummary): string {
  const cause = topCause(s)
  const misses =
    s.misses === 0
      ? "no misses"
      : `${s.misses} miss${s.misses === 1 ? "" : "es"}${cause ? `, mostly ${MISS_CAUSE_LABEL[cause]}` : ""}`
  return `${Math.round(s.hitRate * 100)}% reused · input cost ${Math.round(s.saved * 100)}% lower · ${s.requests} req · ${misses}`
}
