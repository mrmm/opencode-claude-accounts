/**
 * Will the pool last? A pace forecast for the sidebar.
 *
 * Every response records the 5h and weekly utilisation it carried, so the
 * telemetry log is a time series of how fast each window fills. This turns it
 * into one question per window: at the pace we have been going, does the pool
 * run dry before capacity comes back?
 *
 * Pure, like chip.ts: the TUI reads the files and renders what this returns.
 *
 * The model, kept small enough to check by hand:
 *  - Consumption is the sum of RISES in each account's utilisation between
 *    consecutive responses. A fall is a window turning over, never negative use.
 *  - "Now" pace is the last 30 minutes; "typical" is the whole history divided
 *    by the time actually spent working (10-minute buckets with a request), so
 *    a night of idling does not make a busy afternoon look like a spike.
 *  - The forecast simulates the pool forward: usage drains whichever accounts
 *    still have room, and each account's window refills at its own reset.
 *    The 5h window runs at the current pace (it is the one a burst threatens);
 *    the weekly window at the wall-clock average of the last 24h, because a week
 *    includes the nights.
 *  - Utilisation is a fraction of ONE account's window, so a pool of two holds
 *    up to 2.0 and a pace of 0.30/h means "30% of an account per hour".
 */
import type { QuotaCache } from "../balance/index.ts"

export type PaceSample = {
  account: string
  /** Milliseconds. */
  at: number
  u5?: number
  u7?: number
}

export type WindowForecast = {
  /** Fraction of one account per hour. */
  pace: number
  /** Unix seconds when the pool runs dry, or undefined when it lasts. */
  runsOutAt?: number
  /** Unix seconds the simulation covered up to. */
  horizon: number
}

export type Forecast = {
  nowPace: number
  typicalPace: number
  /** nowPace / typicalPace, when both are known. */
  spike?: number
  five: WindowForecast
  week: WindowForecast
  idle: boolean
}

const HOUR = 3600
const NOW_WINDOW_S = 30 * 60
const BUCKET_MS = 10 * 60 * 1000
const STEP_S = 5 * 60
const FIVE_H = 5 * HOUR
const WEEK = 7 * 24 * HOUR

/** Sum of rises per account, counting only pairs that both fall in [from, to] ms. */
export function consumed(
  samples: PaceSample[],
  key: "u5" | "u7",
  fromMs: number,
  toMs: number,
): number {
  const last = new Map<string, number>()
  let total = 0
  for (const s of [...samples].sort((a, b) => a.at - b.at)) {
    const v = s[key]
    if (typeof v !== "number" || s.at < fromMs || s.at > toMs) continue
    const prev = last.get(s.account)
    if (prev !== undefined && v > prev) total += v - prev
    last.set(s.account, v)
  }
  return total
}

/** Hours with at least one request, in 10-minute buckets. */
export function activeHours(
  samples: PaceSample[],
  fromMs: number,
  toMs: number,
): number {
  const buckets = new Set<number>()
  for (const s of samples) {
    if (s.at >= fromMs && s.at <= toMs)
      buckets.add(Math.floor(s.at / BUCKET_MS))
  }
  return (buckets.size * BUCKET_MS) / 3_600_000
}

type Slot = {
  used: number
  resetsAt?: number
  period: number
  blocked: boolean
}

/**
 * Drain the pool at `pace` (fraction per hour) from `now` until `horizon`.
 * Returns the moment no account has room left, or undefined if it lasts.
 */
export function simulate(
  slots: Slot[],
  pace: number,
  now: number,
  horizon: number,
): number | undefined {
  if (pace <= 0) return undefined
  const s = slots.map((x) => ({ ...x }))
  let need = 0
  for (let t = now; t < horizon; t += STEP_S) {
    for (const x of s) {
      if (x.resetsAt !== undefined && t >= x.resetsAt) {
        x.used = 0
        x.resetsAt += x.period
      }
    }
    need += (pace * STEP_S) / HOUR
    for (const x of s) {
      if (need <= 0) break
      if (x.blocked) continue
      const room = Math.max(0, 1 - x.used)
      const take = Math.min(room, need)
      x.used += take
      need -= take
    }
    if (need > 1e-9) return t
  }
  return undefined
}

const frac = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0

/**
 * Forecast both windows for the given accounts.
 *
 * @param now unix seconds
 */
export function forecast(
  samples: PaceSample[],
  quota: QuotaCache,
  accounts: string[],
  now: number = Math.floor(Date.now() / 1000),
): Forecast {
  const nowMs = now * 1000
  const own = samples.filter((s) => accounts.includes(s.account))

  const nowPace =
    (consumed(own, "u5", nowMs - NOW_WINDOW_S * 1000, nowMs) / NOW_WINDOW_S) *
    HOUR
  const first = own.reduce((m, s) => Math.min(m, s.at), nowMs)
  const hrs = activeHours(own, first, nowMs)
  const typicalPace = hrs > 0 ? consumed(own, "u5", first, nowMs) / hrs : 0
  const daySpan = Math.max(
    1,
    (nowMs - Math.max(first, nowMs - 24 * HOUR * 1000)) / 3_600_000,
  )
  const weekPace =
    consumed(own, "u7", nowMs - 24 * HOUR * 1000, nowMs) / daySpan

  const slots = (key: "fiveHour" | "sevenDay", period: number): Slot[] =>
    accounts.map((a) => {
      const q = quota?.[a] as
        | {
            fiveHour?: {
              utilization?: number
              resetsAt?: number
              status?: string
            }
            sevenDay?: {
              utilization?: number
              resetsAt?: number
              status?: string
            }
          }
        | undefined
      const w = q?.[key]
      const resetsAt =
        typeof w?.resetsAt === "number" && w.resetsAt > 0
          ? w.resetsAt
          : undefined
      const turned = resetsAt !== undefined && resetsAt <= now
      // An account out of WEEKLY quota cannot serve the 5h window either.
      const weekGone =
        frac(q?.sevenDay?.utilization) >= 1 &&
        !(
          (q?.sevenDay?.resetsAt ?? 0) <= now &&
          (q?.sevenDay?.resetsAt ?? 0) > 0
        )
      return {
        used: turned ? 0 : frac(w?.utilization),
        resetsAt: turned ? resetsAt + period : resetsAt,
        period,
        blocked: key === "fiveHour" && weekGone,
      }
    })

  const fiveSlots = slots("fiveHour", FIVE_H)
  const fiveHorizon = Math.max(
    now + FIVE_H,
    ...fiveSlots.map((s) => s.resetsAt ?? 0),
  )
  const weekSlots = slots("sevenDay", WEEK)
  const weekHorizon = Math.max(
    now + 24 * HOUR,
    ...weekSlots.map((s) => s.resetsAt ?? 0),
  )

  return {
    nowPace,
    typicalPace,
    spike: nowPace > 0 && typicalPace > 0 ? nowPace / typicalPace : undefined,
    five: {
      pace: nowPace,
      runsOutAt: simulate(fiveSlots, nowPace, now, fiveHorizon),
      horizon: fiveHorizon,
    },
    week: {
      pace: weekPace,
      runsOutAt: simulate(weekSlots, weekPace, now, weekHorizon),
      horizon: weekHorizon,
    },
    idle: nowPace === 0,
  }
}

const pctH = (v: number) => `${Math.round(v * 100)}%/h`

/** Sidebar lines. `clock` renders a unix-seconds moment (resetClock in chip.ts). */
export function forecastLines(
  f: Forecast,
  clock: (epoch: number) => string,
): { text: string; level: "ok" | "warn" | "critical" }[] {
  const spike =
    f.spike !== undefined && f.spike >= 1.5 ? ` ↑${f.spike.toFixed(1)}×` : ""
  const pace = f.idle
    ? `pace idle · typ ${pctH(f.typicalPace)}`
    : `pace ${pctH(f.nowPace)} · typ ${pctH(f.typicalPace)}${spike}`
  const line = (label: string, w: WindowForecast, critical: boolean) =>
    w.runsOutAt === undefined
      ? {
          text: `${label} lasts past ${clock(w.horizon)}`,
          level: "ok" as const,
        }
      : {
          text: `${label} runs out ~${clock(w.runsOutAt)}`,
          level: critical ? ("critical" as const) : ("warn" as const),
        }
  return [
    { text: pace, level: spike ? "warn" : "ok" },
    f.idle
      ? { text: "5h  idle — no forecast", level: "ok" }
      : line("5h ", f.five, true),
    line("wk ", f.week, true),
  ]
}
