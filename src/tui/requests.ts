/**
 * The request trace: recent requests, and the path one of them took.
 *
 * Read from the usage log, which already holds one row per request. Each row
 * carries `steps`, the branches of the request flow it went through
 * (docs/architecture.md, "One request"), so the trace is the diagram with this
 * request's path filled in. Pure, like chip.ts: the TUI passes the rows and a
 * name lookup and renders what comes back.
 */
import type { RequestEvent, UsageEvent } from "../balance/index.ts"

export type NameOf = (accountId: string) => string

export type TraceLine = { section: string; text: string }

const fmtTokens = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}k`
      : String(n)

const clock = (ms: number): string => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const shortModel = (m: string): string => m.replace(/^claude-/, "")

/** Share of input served from cache, or undefined when no usage was read. */
export function cacheShare(e: RequestEvent): number | undefined {
  const read = e.cacheRead ?? 0
  const total = (e.input ?? 0) + read + (e.cacheWrite ?? 0)
  return total > 0 ? read / total : undefined
}

/** Newest first, request rows only, optionally one session's. */
export function recentRequests(
  events: readonly UsageEvent[],
  opts: { session?: string; limit?: number } = {},
): RequestEvent[] {
  return events
    .filter(
      (e): e is RequestEvent =>
        e.kind === "request" &&
        (opts.session === undefined || e.session === opts.session),
    )
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, opts.limit ?? 50)
}

const hasStep = (e: RequestEvent, code: string) =>
  (e.steps ?? []).some((s) => s === code || s.startsWith(`${code}:`))

/** One line in the list: when, who, what, and the outcome at a glance. */
export function requestListRow(
  e: RequestEvent,
  nameOf: NameOf,
): { title: string; description: string } {
  const flags = [
    hasStep(e, "rotate") ? "rotated" : "",
    hasStep(e, "spent") ? "all spent" : "",
    hasStep(e, "prefill-trim") ? "prefill fixed" : "",
    hasStep(e, "auth-401") ? "re-auth" : "",
    hasStep(e, "beta-off") || hasStep(e, "ctx-off") ? "feature dropped" : "",
  ].filter(Boolean)
  const share = cacheShare(e)
  const parts = [
    e.input !== undefined || e.cacheRead !== undefined
      ? `${fmtTokens((e.input ?? 0) + (e.cacheRead ?? 0) + (e.cacheWrite ?? 0))} in · ${fmtTokens(e.output ?? 0)} out`
      : "",
    share !== undefined ? `${Math.round(share * 100)}% cached` : "",
    `${(e.duration_ms / 1000).toFixed(1)}s`,
    ...flags,
  ].filter(Boolean)
  return {
    title: `${clock(e.created_at)}  ${nameOf(e.account)}  ${shortModel(e.model)}  ${e.status}`,
    description: parts.join(" · "),
  }
}

/** A step code as a sentence. Unknown codes are shown as they are. */
export function describeStep(step: string, nameOf: NameOf): string {
  const [code, detail] = [
    step.split(":")[0]!,
    step.slice(step.indexOf(":") + 1),
  ]
  switch (code) {
    case "bound":
      return "account: the one bound to this session"
    case "active":
      return "account: the active account"
    case "ttl-1h":
      return "cache markers sent with a 1h lifetime"
    case "ctx-edit":
      return "context editing added (old tool results may be cleared)"
    case "auth-401":
      return "401: login reloaded or refreshed, then retried"
    case "prefill-trim":
      return `400 prefill: dropped ${detail} trailing assistant turn(s), retried`
    case "ctx-off":
      return "400: context editing refused, turned off, retried without it"
    case "beta-off":
      return `400/429 long context: beta ${detail} excluded, retried`
    case "rotate": {
      const [from, to] = detail.split(">")
      return `429: ${nameOf(from ?? "?")} refused, moved to ${nameOf(to ?? "?")} and retried`
    }
    case "spent":
      return "429: every account spent, answered with the next reset and a paced retry"
    case "status":
      return `answered ${detail}`
    default:
      return step
  }
}

/** The detail view: the request's facts, then its path through the flow. */
export function requestTrace(e: RequestEvent, nameOf: NameOf): TraceLine[] {
  const out: TraceLine[] = []
  const add = (section: string, text: string) => out.push({ section, text })

  add("Request", `${new Date(e.created_at).toLocaleString()} · ${e.model}`)
  add("Request", `session ${e.session ?? "none (title, probe or tool call)"}`)
  add(
    "Request",
    `served by ${nameOf(e.account)} · status ${e.status} · ${(e.duration_ms / 1000).toFixed(1)}s`,
  )

  if (e.steps && e.steps.length > 0) {
    for (const s of e.steps) add("Path", describeStep(s, nameOf))
  } else {
    add("Path", "not recorded (request logged before traces existed)")
  }

  if (e.input !== undefined || e.cacheRead !== undefined) {
    add(
      "Tokens",
      `input ${fmtTokens(e.input ?? 0)} uncached · ${fmtTokens(e.cacheRead ?? 0)} from cache · ${fmtTokens(e.cacheWrite ?? 0)} written to cache`,
    )
    add("Tokens", `output ${fmtTokens(e.output ?? 0)}`)
    const share = cacheShare(e)
    if (share !== undefined)
      add("Tokens", `${Math.round(share * 100)}% of input came from cache`)
  } else {
    add("Tokens", "no usage in the response (not a chat call, or refused)")
  }

  const q = [
    e.utilization_5h !== undefined
      ? `5h ${Math.round(e.utilization_5h * 100)}%`
      : "",
    e.utilization_7d !== undefined
      ? `week ${Math.round(e.utilization_7d * 100)}%`
      : "",
  ].filter(Boolean)
  add(
    "Quota after",
    q.length ? `${nameOf(e.account)}: ${q.join(" · ")}` : "no reading",
  )
  return out
}
