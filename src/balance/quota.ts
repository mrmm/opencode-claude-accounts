/**
 * Per-account quota, read from Anthropic's unified rate-limit response headers.
 *
 * Every API response carries the caller's current utilisation and reset time:
 *
 *   anthropic-ratelimit-unified-5h-utilization: 1.0
 *   anthropic-ratelimit-unified-5h-reset: 1785167400
 *   anthropic-ratelimit-unified-5h-status: rejected
 *   anthropic-ratelimit-unified-7d-utilization: 0.92
 *   anthropic-ratelimit-unified-representative-claim: five_hour
 *
 * This is the only usable source here. claude.ai's /api/organizations/{id}/usage
 * needs a web `sessionKey` cookie and an organisation id; the plugin holds OAuth
 * tokens for api.anthropic.com (scopes user:inference, user:profile, ...), which
 * that endpoint does not accept. Headers cost nothing extra -- they arrive with
 * traffic the plugin already proxies.
 *
 * Values are cached to disk per account because the account switcher builds its
 * options synchronously and cannot await a request.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** One rate-limit window. */
export type QuotaWindow = {
  /** Fraction consumed, 0..1+ (1.0 means the window is exhausted). */
  utilization: number
  /** Unix seconds when the window resets, or undefined if absent. */
  resetsAt?: number
  /** Server's own verdict: allowed | allowed_warning | rejected. */
  status?: string
}

/**
 * Paid overflow once the included allowance is gone.
 *
 * Absent from the rate-limit headers entirely, and decisive: an account whose
 * included window is spent still serves normally while credits are enabled and
 * under their cap. Reading the window alone says "exhausted" about an account
 * that is answering every request.
 */
export type ExtraUsage = {
  enabled: boolean
  /** Minor units, as the API reports them -- 21730 is EUR 217.30. */
  usedMinor?: number
  limitMinor?: number
  currency?: string
  /** The server's own verdict, not a comparison we derive. */
  capReached: boolean
}

/**
 * Whether credits can actually pay for the next request.
 *
 * `is_enabled` alone is not the question, and reading it as if it were put a
 * live account at 200.35 of a 200.00 cap into the rotation and left one with
 * 66 EUR of headroom idle. Two ways an enabled credit line covers nothing:
 * the cap is zero (enabled, never funded -- a real account reports exactly
 * that), or the spend has reached it. `spend_limit_reached` is the server's
 * own flag and it is trusted when set, but it is not the only way to be out.
 */
export function creditHeadroom(extra: ExtraUsage | undefined): boolean {
  if (!extra?.enabled || extra.capReached) return false
  const { usedMinor, limitMinor } = extra
  // Unknown figures: enabled and not flagged is the best evidence there is.
  if (limitMinor === undefined || usedMinor === undefined) return true
  return limitMinor > 0 && usedMinor < limitMinor
}

/** A limit the server says is currently binding. */
export type ActiveLimit = {
  kind: string
  percent: number
  severity: string
  resetsAt?: number
}

export type AccountQuota = {
  fiveHour?: QuotaWindow
  sevenDay?: QuotaWindow
  /** Which window the server says is currently binding. */
  representative?: string
  /** When these values were observed (unix seconds). */
  observedAt: number
  /** Paid overflow state. Only the usage endpoint reports it. */
  extra?: ExtraUsage
  /** Limits the server marks active -- authoritative, not inferred. */
  activeLimits?: ActiveLimit[]
  /** Which organization this account bills against. */
  orgName?: string
}

const PREFIX = "anthropic-ratelimit-unified-"

/** Header bag, tolerating a real Headers instance or a plain object. */
export type HeaderLike =
  | Headers
  | { get?: (name: string) => string | null; [key: string]: unknown }

function headerValue(headers: HeaderLike, name: string): string | undefined {
  if (!headers) return undefined

  const getter = (headers as { get?: unknown }).get
  if (typeof getter === "function") {
    const v = (getter as (n: string) => string | null).call(headers, name)
    return v === null || v === undefined ? undefined : String(v)
  }

  // Plain objects may be keyed with any casing.
  const bag = headers as Record<string, unknown>
  const direct = bag[name]
  if (typeof direct === "string") return direct
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(bag)) {
    if (k.toLowerCase() === lower && typeof v === "string") return v
  }
  return undefined
}

function parseWindow(
  headers: HeaderLike,
  key: "5h" | "7d",
): QuotaWindow | undefined {
  const util = headerValue(headers, `${PREFIX}${key}-utilization`)
  if (util === undefined) return undefined

  const utilization = Number.parseFloat(util)
  if (!Number.isFinite(utilization)) return undefined

  const resetRaw = headerValue(headers, `${PREFIX}${key}-reset`)
  const reset = resetRaw ? Number.parseInt(resetRaw, 10) : Number.NaN

  return {
    utilization,
    resetsAt: Number.isFinite(reset) ? reset : undefined,
    status: headerValue(headers, `${PREFIX}${key}-status`),
  }
}

/**
 * Read quota from response headers, or undefined when none are present.
 *
 * Absence is normal: non-Anthropic responses and errors raised before the
 * upstream call carry no such headers.
 */
export function parseQuotaHeaders(
  headers: HeaderLike,
  now: number = Math.floor(Date.now() / 1000),
): AccountQuota | undefined {
  const fiveHour = parseWindow(headers, "5h")
  const sevenDay = parseWindow(headers, "7d")
  if (!fiveHour && !sevenDay) return undefined

  return {
    fiveHour,
    sevenDay,
    representative: headerValue(headers, `${PREFIX}representative-claim`),
    observedAt: now,
  }
}

/** Compact duration: 45s, 12m, 1h20m, 2d3h. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "now"
  const s = Math.floor(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) {
    const rem = m % 60
    return rem ? `${h}h${String(rem).padStart(2, "0")}m` : `${h}h`
  }
  const d = Math.floor(h / 24)
  const remH = h % 24
  return remH ? `${d}d${remH}h` : `${d}d`
}

/** The window that matters: the server's representative claim, else the fuller. */
export function bindingWindow(q: AccountQuota): QuotaWindow | undefined {
  if (q.representative === "seven_day" && q.sevenDay) return q.sevenDay
  if (q.representative === "five_hour" && q.fiveHour) return q.fiveHour
  if (q.fiveHour && q.sevenDay) {
    return q.sevenDay.utilization > q.fiveHour.utilization
      ? q.sevenDay
      : q.fiveHour
  }
  return q.fiveHour ?? q.sevenDay
}

/**
 * Prefix for an account switcher row, e.g. "[100% 1h20m]" or "[22% 2h05m]".
 *
 * Returns "" when nothing is known, so a row is never padded with noise.
 * A window already past its reset reads as 0% -- the reset happened, and
 * showing the stale figure would be actively misleading.
 */
export function formatQuotaPrefix(
  quota: AccountQuota | undefined,
  now: number = Math.floor(Date.now() / 1000),
): string {
  if (!quota) return ""
  const w = bindingWindow(quota)
  if (!w) return ""

  const expired = w.resetsAt !== undefined && w.resetsAt <= now
  if (expired) return "[0%]"

  const pct = Math.round(Math.min(Math.max(w.utilization, 0), 1) * 100)
  const remaining =
    w.resetsAt !== undefined ? formatDuration(w.resetsAt - now) : undefined

  return remaining ? `[${pct}% ${remaining}]` : `[${pct}%]`
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function quotaCachePath(): string {
  return join(
    homedir(),
    ".local",
    "share",
    "opencode",
    "claude-auth-quota.json",
  )
}

export type QuotaCache = Record<string, AccountQuota>

/** Read the cache; a missing or corrupt file is simply "no data". */
export function readQuotaCache(path: string = quotaCachePath()): QuotaCache {
  try {
    if (!existsSync(path)) return {}
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    return parsed && typeof parsed === "object" ? (parsed as QuotaCache) : {}
  } catch {
    return {}
  }
}

/**
 * Record one account's quota.
 *
 * Never throws: this runs on the response path of every request, where an
 * unwritable cache must not surface as a failed API call.
 */
export function writeQuotaForAccount(
  source: string,
  quota: AccountQuota,
  path: string = quotaCachePath(),
): boolean {
  try {
    const cache = readQuotaCache(path)
    // Merge, never replace. Two writers reach this cache and they know
    // different things: a response carries headers (windows, status,
    // representative) and a probe carries what no header mentions (credits,
    // the binding limit). Replacing meant every response erased the probe --
    // so the BUSIEST account lost its credit state fastest, which is exactly
    // the account whose credit state decides anything.
    const prior = cache[source]
    cache[source] = {
      ...(prior?.extra !== undefined ? { extra: prior.extra } : {}),
      ...(prior?.activeLimits !== undefined
        ? { activeLimits: prior.activeLimits }
        : {}),
      ...quota,
    }
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8")
    return true
  } catch {
    return false
  }
}

/** Quota for one account, dropping entries older than `maxAgeSeconds`. */
export function quotaForAccount(
  source: string,
  cache: QuotaCache,
  now: number = Math.floor(Date.now() / 1000),
  maxAgeSeconds = 60 * 60 * 12,
): AccountQuota | undefined {
  const q = cache?.[source]
  if (!q || typeof q.observedAt !== "number") return undefined
  if (now - q.observedAt > maxAgeSeconds) return undefined
  return q
}

// ---------------------------------------------------------------------------
// Filling rows the passive path cannot reach
// ---------------------------------------------------------------------------

/**
 * Passive capture only ever learns about the account currently serving traffic,
 * which is the one row the user already knows. Comparing accounts in the
 * switcher needs a figure for each, so every account is probed once per
 * session with a 1-token request.
 *
 * Cost is deliberately near-zero: an exhausted account answers 429 and consumes
 * nothing, and a healthy one spends a single token. Accounts with a reading
 * newer than `maxAgeSeconds` are skipped entirely.
 */
export type ProbeAccount = { source: string; accessToken: string }

/**
 * Per-process, because it only has to outlive the next probe sweep. Losing it
 * on restart costs one refused call, which is cheaper than persisting it.
 */
const probeBlockedUntil = new Map<string, number>()

export function blockProbe(source: string, until: number): void {
  probeBlockedUntil.set(source, until)
}

export function probeBlocked(source: string, now: number): boolean {
  const until = probeBlockedUntil.get(source)
  if (until === undefined) return false
  if (until <= now) {
    probeBlockedUntil.delete(source)
    return false
  }
  return true
}

export function resetProbeBlocks(): void {
  probeBlockedUntil.clear()
}

export type ProbeResult = {
  probed: number
  skipped: number
  failed: number
}

export const PROBE_MODEL = "claude-haiku-4-5-20251001"

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage"

/** Read an account's usage without spending any of it. */
export function buildUsageRequest(accessToken: string): [string, RequestInit] {
  return [USAGE_URL, { headers: { authorization: `Bearer ${accessToken}` } }]
}

function epoch(iso: unknown): number | undefined {
  if (typeof iso !== "string") return undefined
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}

/**
 * The usage endpoint's body, in the shape the header path already produces.
 *
 * Two conversions that are silent if missed: this endpoint reports utilisation
 * as a PERCENT (0-100) where the headers report a FRACTION (0-1), and its reset
 * times are ISO strings where the headers carry unix seconds.
 */
export function parseUsageBody(
  body: unknown,
  now: number = Math.floor(Date.now() / 1000),
): AccountQuota | undefined {
  if (!body || typeof body !== "object") return undefined
  const b = body as Record<string, any>

  const win = (w: unknown): QuotaWindow | undefined => {
    if (!w || typeof w !== "object") return undefined
    const o = w as Record<string, unknown>
    if (typeof o.utilization !== "number") return undefined
    return {
      utilization: o.utilization / 100,
      ...(epoch(o.resets_at) === undefined
        ? {}
        : { resetsAt: epoch(o.resets_at) }),
    }
  }

  const five = win(b.five_hour)
  const week = win(b.seven_day)
  if (!five && !week) return undefined

  const x = b.extra_usage as Record<string, unknown> | undefined
  const spend = b.spend as Record<string, any> | undefined
  const extra: ExtraUsage | undefined = x
    ? {
        enabled: x.is_enabled === true,
        capReached: x.spend_limit_reached === true,
        ...(typeof spend?.used?.amount_minor === "number"
          ? { usedMinor: spend.used.amount_minor }
          : {}),
        ...(typeof spend?.limit?.amount_minor === "number"
          ? { limitMinor: spend.limit.amount_minor }
          : {}),
        ...(typeof x.currency === "string" ? { currency: x.currency } : {}),
      }
    : undefined

  const activeLimits: ActiveLimit[] = Array.isArray(b.limits)
    ? b.limits
        .filter((l: any) => l?.is_active === true)
        .map((l: any) => {
          const row: ActiveLimit = {
            kind: String(l.kind ?? "unknown"),
            percent: Number(l.percent ?? 0),
            severity: String(l.severity ?? "normal"),
          }
          const at = epoch(l.resets_at)
          if (at !== undefined) row.resetsAt = at
          return row
        })
    : []

  return {
    ...(five ? { fiveHour: five } : {}),
    ...(week ? { sevenDay: week } : {}),
    ...(extra ? { extra } : {}),
    ...(activeLimits.length ? { activeLimits } : {}),
    observedAt: now,
  }
}

/** Minimal request the API will answer with rate-limit headers attached. */
export function buildProbeRequest(accessToken: string): [string, RequestInit] {
  return [
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        model: PROBE_MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    },
  ]
}

/**
 * Refresh quota for the given accounts, writing what it learns to the cache.
 *
 * Resolves rather than rejects on network failure: this runs detached from
 * start-up and must never surface as an error to the user.
 */
export async function refreshQuotas(
  accounts: ProbeAccount[],
  options: {
    fetchImpl?: typeof fetch
    path?: string
    now?: () => number
    maxAgeSeconds?: number
  } = {},
): Promise<ProbeResult> {
  const {
    fetchImpl = fetch,
    path = quotaCachePath(),
    now = () => Math.floor(Date.now() / 1000),
    maxAgeSeconds = 10 * 60,
  } = options

  const result: ProbeResult = { probed: 0, skipped: 0, failed: 0 }
  const cache = readQuotaCache(path)

  for (const account of accounts ?? []) {
    if (!account?.source || !account?.accessToken) {
      result.failed++
      continue
    }
    // Fresh is not the same as complete. The serving account gets a new
    // header reading on every request, so it is permanently young -- and a
    // header carries no extra-usage or limits data at all. Judging the probe
    // by age alone meant the busiest account could never acquire the only
    // fields the probe exists to fetch.
    const held = quotaForAccount(account.source, cache, now(), maxAgeSeconds)
    if (held && held.extra !== undefined) {
      result.skipped++
      continue
    }
    if (probeBlocked(account.source, now())) {
      result.skipped++
      continue
    }

    try {
      const [url, init] = buildUsageRequest(account.accessToken)
      const res = await fetchImpl(url, init)

      // This endpoint allows roughly one call an hour per account and answers
      // 429 with a retry-after measured in thousands of seconds. Probing
      // through that would spend the whole budget on being refused.
      if (res.status === 429) {
        const after = Number.parseInt(
          (res.headers as Headers)?.get?.("retry-after") ?? "",
          10,
        )
        blockProbe(
          account.source,
          now() + (Number.isFinite(after) ? after : 3600),
        )
        result.skipped++
        continue
      }

      const quota = parseUsageBody(await res.json().catch(() => null), now())
      if (quota) {
        // No merge here: writeQuotaForAccount owns that now, for both writers.
        writeQuotaForAccount(account.source, quota, path)
        result.probed++
      } else {
        // 401 from an expired token, or a body in a shape we do not know.
        result.failed++
      }
    } catch {
      result.failed++
    }
  }

  return result
}
