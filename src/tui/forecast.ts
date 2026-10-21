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
import { lineChart, type Row } from "./tokens.ts"

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
  /** 5h-window burn per bucket over the last CHART_S, oldest first. */
  history: number[]
  /** Pool room left per simulation step over the next CHART_S at nowPace. */
  ahead: number[]
  /** Unix seconds the forecast was taken at. */
  now: number
  /** Each account's next 5h reset, soonest first. */
  resets: { account: string; at: number; used: number }[]
}

const HOUR = 3600
const NOW_WINDOW_S = 30 * 60
const BUCKET_MS = 10 * 60 * 1000
const STEP_S = 5 * 60
const FIVE_H = 5 * HOUR
const WEEK = 7 * 24 * HOUR
const CHART_S = FIVE_H
const CHART_BUCKETS = 20
const CHART_ROWS = 3

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

/**
 * Burn per bucket over [toMs - spanMs, toMs]. Each rise is booked to the bucket
 * of the response that carried it, so a rise straddling a boundary is not lost.
 */
export function burnHistory(
  samples: PaceSample[],
  toMs: number,
  spanMs: number,
  buckets: number,
): number[] {
  const out = Array.from({ length: buckets }, () => 0)
  const fromMs = toMs - spanMs
  const last = new Map<string, number>()
  for (const s of [...samples].sort((a, b) => a.at - b.at)) {
    const v = s.u5
    if (typeof v !== "number" || s.at > toMs) continue
    const prev = last.get(s.account)
    last.set(s.account, v)
    if (prev === undefined || v <= prev || s.at < fromMs) continue
    const i = Math.min(
      buckets - 1,
      Math.floor(((s.at - fromMs) / spanMs) * buckets),
    )
    out[i]! += v - prev
  }
  return out
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
  trace?: (room: number) => void,
): number | undefined {
  if (pace <= 0 && !trace) return undefined
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
    trace?.(
      s.reduce((r, x) => r + (x.blocked ? 0 : Math.max(0, 1 - x.used)), 0),
    )
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

  const ahead: number[] = []
  simulate(fiveSlots, nowPace, now, now + CHART_S, (r) => ahead.push(r))
  while (ahead.length < CHART_S / STEP_S) ahead.push(0)

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
    history: burnHistory(own, nowMs, CHART_S * 1000, CHART_BUCKETS),
    ahead,
    now,
    resets: fiveSlots
      .flatMap((x, i) =>
        x.resetsAt === undefined || x.blocked
          ? []
          : [{ account: accounts[i]!, at: x.resetsAt, used: x.used }],
      )
      .sort((a, b) => a.at - b.at),
  }
}

const pctH = (v: number) => `${Math.round(v * 100)}%/h`

/** Sidebar lines. `clock` renders a unix-seconds moment (resetClock in chip.ts). */
export function forecastLines(
  f: Forecast,
  clock: (epoch: number) => string,
  names: Map<string, string> = new Map(),
): Row[] {
  const spike =
    f.spike !== undefined && f.spike >= 1.5 ? ` ↑${f.spike.toFixed(1)}×` : ""
  const line = (label: string, w: WindowForecast) =>
    w.runsOutAt === undefined
      ? {
          label,
          value: `✓ lasts past ${clock(w.horizon)}`,
          level: "ok" as const,
        }
      : {
          label,
          value: `✗ runs out ~${clock(w.runsOutAt)}`,
          level: "critical" as const,
        }
  return [
    {
      label: "now",
      value: f.idle ? "idle" : `${pctH(f.nowPace)}${spike}`,
      level: spike ? "warn" : "ok",
    },
    { label: "typical", value: pctH(f.typicalPace), level: "ok" },
    f.idle
      ? { label: "5h", value: "idle — no forecast", level: "ok" }
      : line("5h", f.five),
    line("week", f.week),
    ...chartLines(f, clock, names),
  ]
}

const pct = (v: number) => `${Math.round(v * 100)}%`

/** `text` at `col` in a `width`-wide line, kept inside it. */
function place(line: string[], col: number, text: string): void {
  const at = Math.max(0, Math.min(line.length - text.length, col))
  for (let i = 0; i < text.length; i++) line[at + i] = text[i]!
}

/**
 * Two line charts with axes: what the last 5h burned (%/h of one account), and
 * how much of the pool is left over the next 5h if the current pace holds (% of
 * one account, so a pool of two tops out at 200%). The scale sits at the right
 * of the top and bottom rows; clock times run under each chart, and under the
 * projection each account's reset is marked by its number where it lands, so a
 * jump in the line has a visible cause.
 */
export function chartLines(
  f: Forecast,
  clock: (epoch: number) => string = String,
  names: Map<string, string> = new Map(),
): Row[] {
  const rows: Row[] = []
  const W = CHART_BUCKETS
  const name = (a: string) => names.get(a) ?? a
  const mark = (a: string) =>
    name(a).match(/\d(?!.*\d)/)?.[0] ?? name(a)[0] ?? "?"

  const chart = (
    labels: string[],
    lines: string[],
    top: string,
    tone: Row["tone"],
    level: Row["level"] = "ok",
  ) =>
    lines.forEach((l, i) =>
      rows.push({
        label: labels[i] ?? "",
        value: i === 0 ? `${l} ${top}` : i === lines.length - 1 ? `${l} 0` : l,
        level,
        tone,
      }),
    )
  // Three clock ticks: start, middle, end of the chart's span.
  const ticks = (from: number, marks: { col: number; ch: string }[] = []) => {
    const axis = Array.from({ length: W }, () => "─")
    for (const m of marks) if (m.col >= 0 && m.col < W) axis[m.col] = m.ch
    rows.push({
      label: "",
      value: `${axis.join("")}┘`,
      level: "ok",
      tone: "axis",
    })
    const times = Array.from({ length: W + 6 }, () => " ")
    place(times, 0, clock(from))
    place(times, Math.round(W / 2) - 2, clock(from + CHART_S / 2))
    place(times, W - 2, clock(from + CHART_S))
    rows.push({
      label: "",
      value: times.join("").trimEnd(),
      level: "ok",
      tone: "axis",
    })
  }

  if (f.history.length > 0) {
    const perHour = f.history.map((v) => (v * CHART_BUCKETS * HOUR) / CHART_S)
    const top = Math.max(...perHour)
    const burned = f.history.reduce((a, v) => a + v, 0)
    chart(
      ["burn %/h", `total ${pct(burned)}`],
      lineChart(perHour, W, CHART_ROWS),
      `${Math.round(top * 100)}`,
      "burn",
    )
    ticks(f.now - CHART_S)
  }
  if (f.ahead.length > 0) {
    const end = f.ahead[f.ahead.length - 1]!
    const top = Math.max(...f.ahead, 1)
    chart(
      ["left %", `at end ${pct(end)}`],
      lineChart(f.ahead, W, CHART_ROWS, top),
      `${Math.round(top * 100)}`,
      "projection",
      end <= 0 ? "critical" : end < 0.2 ? "warn" : "ok",
    )
    ticks(
      f.now,
      f.resets.map((r) => ({
        col: Math.floor(((r.at - f.now) / CHART_S) * W),
        ch: mark(r.account),
      })),
    )
  }
  return rows
}
