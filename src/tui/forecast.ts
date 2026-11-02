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
 *  - Capacity per account is its CEILING (default 1): the share the operator
 *    allows the pool to spend before leaving the rest for outside users. The
 *    pool "runs out" when it reaches those ceilings, not the full windows.
 *  - Two things drain a window: our own traffic, and everyone else on the same
 *    subscription. `outsideBurn` learns each account's utilisation-per-token
 *    ratio from buckets where WE sent tokens, then books the rise it cannot
 *    explain (plus any rise in a bucket where we sent nothing) to the outside.
 *  - The forecast simulates the pool forward: our pace drains whichever accounts
 *    still have room, each account's own outside pace drains it regardless, and
 *    each window refills at its reset. The 5h window runs at the current pace;
 *    the weekly window at the wall-clock average of the last 24h.
 *  - Utilisation is a fraction of ONE account's window, so a pool of two holds
 *    up to 2.0 and a pace of 0.30/h means "30% of an account per hour".
 */
import { formatDuration, type QuotaCache } from "../balance/index.ts"
import { lineChart, type Row } from "./tokens.ts"

export type PaceSample = {
  account: string
  /** Milliseconds. */
  at: number
  u5?: number
  u7?: number
  /** Requests in this bucket. Absent (fallback source) is treated as unknown. */
  reqs?: number
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

/** A learned burn pace for one account and window, or unknown when too few buckets back it. */
export type OutsidePace = {
  /** Fraction of the account's window per hour (5h) or per day (7d). Undefined when unknown. */
  pace?: number
  /** How many buckets fed the estimate. 0 => unknown. */
  buckets: number
}

export type WindowForecast = {
  /** Our own consumption, fraction of one account per hour (5h) or per day (7d). */
  pace: number
  /** Our pace + the pool's outside pace: what the simulation actually drains. */
  ourPace: number
  outsidePace: number
  /** Unix seconds when the pool runs dry, or undefined when it lasts. */
  runsOutAt?: number
  /** Unix seconds the simulation covered up to. */
  horizon: number
  /** Room above the ceilings, summed over accounts: what is left for outside users. */
  reserveLeft: number
}

export type AccountForecast = {
  account: string
  /** Current utilisation of this account's window, fraction 0..1. */
  used: number
  /** The ceiling the operator allows the pool to spend, fraction 0..1. */
  ceiling: number
  /** Our pace against this account, fraction of the window per hour (5h) / per day (7d). */
  ourPace: number
  /** Outside burn against this account, same unit. Undefined when unknown. */
  outsidePace?: number
  /** Unix seconds this account alone runs out against its ceiling, if it does. */
  runsOutAt?: number
}

export type Forecast = {
  nowPace: number
  typicalPace: number
  /** nowPace / typicalPace, when both are known. */
  spike?: number
  five: WindowForecast
  week: WindowForecast
  fivePerAccount: AccountForecast[]
  weekPerAccount: AccountForecast[]
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

/** Optional inputs: ceilings cap each account's usable window; 1 (full window) is the default. */
export type ForecastOpts = {
  /** Per-account ceiling per window, fraction 0..1. Missing account => full window. */
  ceilings?: Record<string, { five: number; week: number }>
}

const HOUR = 3600
const DAY = 24 * HOUR
const NOW_WINDOW_S = 30 * 60
const BUCKET_MS = 10 * 60 * 1000
const STEP_S = 5 * 60
const FIVE_H = 5 * HOUR
const WEEK = 7 * DAY
const CHART_S = FIVE_H
const CHART_BUCKETS = 20
const CHART_ROWS = 3
/** Below this many token-bearing buckets, the per-token ratio is noise, not a signal. */
const MIN_RATIO_BUCKETS = 5
/** Below this many window buckets, outside burn is unknown rather than zero. */
const MIN_OUTSIDE_BUCKETS = 3

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

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

const tokens = (s: PaceSample): number =>
  (s.input ?? 0) + (s.output ?? 0) + (s.cacheRead ?? 0) + (s.cacheWrite ?? 0)

/**
 * How fast each account's window is drained by traffic that is NOT ours.
 *
 * We only see the utilisation gauge move; it moves for our requests and for
 * everyone else on the same subscription. So we learn, per account, how much
 * the gauge rises per token WE send (the median ratio over buckets where we did
 * send tokens, which is robust to the odd outlier), then attribute to the
 * outside whatever rise a bucket shows beyond what our tokens explain — and all
 * of any rise in a bucket where we sent nothing at all (the idle-probe signal).
 *
 * Pure. Returns a pace per hour for the 5h window and per day for the 7d window,
 * marked unknown (undefined pace) when too few buckets back it to trust.
 *
 * @param now unix seconds
 */
export function outsideBurn(
  samples: PaceSample[],
  now: number,
): Record<string, { five: OutsidePace; week: OutsidePace }> {
  const nowMs = now * 1000
  const byAccount = new Map<string, PaceSample[]>()
  for (const s of samples) {
    const arr = byAccount.get(s.account) ?? []
    arr.push(s)
    byAccount.set(s.account, arr)
  }

  const out: Record<string, { five: OutsidePace; week: OutsidePace }> = {}
  for (const [account, rows] of byAccount) {
    const sorted = [...rows].sort((a, b) => a.at - b.at)

    // Learn k = utilisation rise per token, from buckets we drove.
    const ratios: number[] = []
    let prev5: number | undefined
    for (const s of sorted) {
      const v = s.u5
      const tok = tokens(s)
      if (typeof v === "number") {
        if (prev5 !== undefined && v > prev5 && tok > 0)
          ratios.push((v - prev5) / tok)
        prev5 = v
      }
    }
    const k = ratios.length >= MIN_RATIO_BUCKETS ? median(ratios) : undefined

    const windowPace = (
      key: "u5" | "u7",
      fromMs: number,
      perSeconds: number,
    ): OutsidePace => {
      let outside = 0
      let buckets = 0
      let prev: number | undefined
      for (const s of sorted) {
        const v = s[key]
        if (typeof v !== "number") continue
        if (s.at < fromMs) {
          prev = v
          continue
        }
        if (prev !== undefined) {
          buckets++
          const rise = Math.max(0, v - prev)
          const ours = k !== undefined ? k * tokens(s) : 0
          outside += Math.max(0, rise - ours)
        }
        prev = v
      }
      if (buckets < MIN_OUTSIDE_BUCKETS) return { pace: undefined, buckets }
      const spanS = (nowMs - fromMs) / 1000
      return {
        pace: spanS > 0 ? (outside / spanS) * perSeconds : 0,
        buckets,
      }
    }

    out[account] = {
      five: windowPace("u5", nowMs - FIVE_H * 1000, HOUR),
      week: windowPace("u7", nowMs - WEEK * 1000, DAY),
    }
  }
  return out
}

type Slot = {
  used: number
  /** Ceiling: the pool may spend up to here, leaving 1 - ceiling in reserve. Default 1. */
  ceiling?: number
  resetsAt?: number
  period: number
  blocked: boolean
  /** Outside pace, fraction of this account's window per STEP (not per hour). Default 0. */
  outsidePerStep?: number
}

/**
 * Drain the pool at `pace` (fraction per hour) from `now` until `horizon`.
 * Returns the moment no account has room left, or undefined if it lasts.
 *
 * Capacity is each slot's ceiling, so "room" is `ceiling - used`. Outside burn
 * drains each slot independently every step, before we take our share; a reset
 * zeroes a slot's usage and pushes its boundary one period out.
 */
export function simulate(
  slots: Slot[],
  pace: number,
  now: number,
  horizon: number,
  trace?: (room: number) => void,
): number | undefined {
  const anyOutside = slots.some((x) => (x.outsidePerStep ?? 0) > 0)
  if (pace <= 0 && !anyOutside && !trace) return undefined
  const s = slots.map((x) => ({
    ...x,
    ceiling: x.ceiling ?? 1,
    outsidePerStep: x.outsidePerStep ?? 0,
  }))
  const room = (x: { ceiling: number; used: number }) =>
    Math.max(0, x.ceiling - x.used)
  let need = 0
  for (let t = now; t < horizon; t += STEP_S) {
    for (const x of s) {
      if (x.resetsAt !== undefined && t >= x.resetsAt) {
        x.used = 0
        x.resetsAt += x.period
      }
    }
    // Outside users spend first; they do not respect our ceilings.
    for (const x of s) if (!x.blocked) x.used += x.outsidePerStep
    need += (pace * STEP_S) / HOUR
    for (const x of s) {
      if (need <= 0) break
      if (x.blocked) continue
      const take = Math.min(room(x), need)
      x.used += take
      need -= take
    }
    trace?.(s.reduce((r, x) => r + (x.blocked ? 0 : room(x)), 0))
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
  opts: ForecastOpts = {},
): Forecast {
  const nowMs = now * 1000
  const own = samples.filter((s) => accounts.includes(s.account))
  const ceilings = opts.ceilings ?? {}
  const ceilingOf = (a: string, w: "five" | "week") => {
    const c = ceilings[a]?.[w]
    return c === undefined ? 1 : frac(c)
  }

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

  const burn = outsideBurn(own, now)

  const slots = (
    key: "fiveHour" | "sevenDay",
    w: "five" | "week",
    period: number,
  ): Slot[] =>
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
      const win = q?.[key]
      const resetsAt =
        typeof win?.resetsAt === "number" && win.resetsAt > 0
          ? win.resetsAt
          : undefined
      const turned = resetsAt !== undefined && resetsAt <= now
      // An account out of WEEKLY quota cannot serve the 5h window either.
      const weekGone =
        frac(q?.sevenDay?.utilization) >= 1 &&
        !(
          (q?.sevenDay?.resetsAt ?? 0) <= now &&
          (q?.sevenDay?.resetsAt ?? 0) > 0
        )
      const outsidePerHour = burn[a]?.[w]?.pace ?? 0
      const perStepDivisor = w === "five" ? HOUR / STEP_S : DAY / STEP_S
      return {
        used: turned ? 0 : frac(win?.utilization),
        ceiling: ceilingOf(a, w),
        resetsAt: turned ? resetsAt + period : resetsAt,
        period,
        blocked: key === "fiveHour" && weekGone,
        outsidePerStep: outsidePerHour / perStepDivisor,
      }
    })

  const fiveSlots = slots("fiveHour", "five", FIVE_H)
  const fiveHorizon = Math.max(
    now + 24 * HOUR,
    ...fiveSlots.map((s) => s.resetsAt ?? 0),
  )
  const weekSlots = slots("sevenDay", "week", WEEK)
  const weekHorizon = Math.max(
    now + WEEK,
    ...weekSlots.map((s) => s.resetsAt ?? 0),
  )

  const ahead: number[] = []
  simulate(fiveSlots, nowPace, now, now + CHART_S, (r) => ahead.push(r))
  while (ahead.length < CHART_S / STEP_S) ahead.push(0)

  const outsideSum = (w: "five" | "week") =>
    accounts.reduce((r, a) => r + (burn[a]?.[w]?.pace ?? 0), 0)

  const reserveLeft = (sl: Slot[]) =>
    sl.reduce(
      (r, x) =>
        r + (x.blocked ? 0 : Math.max(0, 1 - Math.max(x.used, x.ceiling ?? 1))),
      0,
    )

  const perAccount = (
    sl: Slot[],
    w: "five" | "week",
    horizon: number,
  ): AccountForecast[] =>
    accounts.map((a, i) => {
      const slot = sl[i]!
      const outsidePace = burn[a]?.[w]?.pace
      // This account alone against its ceiling: our whole pace on just this slot.
      const solo = simulate(
        [{ ...slot }],
        w === "five" ? nowPace : weekPace,
        now,
        horizon,
      )
      return {
        account: a,
        used: slot.used,
        ceiling: slot.ceiling ?? 1,
        ourPace: slot.blocked ? 0 : w === "five" ? nowPace : weekPace,
        outsidePace,
        runsOutAt: slot.blocked ? undefined : solo,
      }
    })

  const fiveOutside = outsideSum("five")
  const weekOutside = outsideSum("week")

  return {
    nowPace,
    typicalPace,
    spike: nowPace > 0 && typicalPace > 0 ? nowPace / typicalPace : undefined,
    five: {
      pace: nowPace,
      ourPace: nowPace,
      outsidePace: fiveOutside,
      runsOutAt: simulate(fiveSlots, nowPace, now, fiveHorizon),
      horizon: fiveHorizon,
      reserveLeft: reserveLeft(fiveSlots),
    },
    week: {
      pace: weekPace,
      ourPace: weekPace,
      outsidePace: weekOutside,
      runsOutAt: simulate(weekSlots, weekPace, now, weekHorizon),
      horizon: weekHorizon,
      reserveLeft: reserveLeft(weekSlots),
    },
    fivePerAccount: perAccount(fiveSlots, "five", fiveHorizon),
    weekPerAccount: perAccount(weekSlots, "week", weekHorizon),
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
const pctD = (v: number) => `${Math.round(v * 100)}%/d`

/** Sidebar lines. `clock` renders a unix-seconds moment (resetClock in chip.ts). */
export function forecastLines(
  f: Forecast,
  clock: (epoch: number) => string,
  names: Map<string, string> = new Map(),
): Row[] {
  const name = (a: string) => names.get(a) ?? a
  const spike =
    f.spike !== undefined && f.spike >= 1.5 ? ` ↑${f.spike.toFixed(1)}×` : ""
  // How long the pool lasts at the window's pace, and the clock time it ends.
  const line = (label: string, w: WindowForecast): Row =>
    w.runsOutAt === undefined
      ? {
          label,
          value: `✓ lasts >${formatDuration(w.horizon - f.now)} · past ${clock(w.horizon)}`,
          level: "ok",
        }
      : {
          label,
          value: `✗ out in ${formatDuration(w.runsOutAt - f.now)} · ~${clock(w.runsOutAt)}`,
          level: w.runsOutAt - f.now < HOUR ? "critical" : "warn",
        }
  // "ours x/h · outside y/h" so a surprise can be blamed on the pool's neighbours.
  const burnLine = (
    label: string,
    w: WindowForecast,
    unit: typeof pctH,
  ): Row => ({
    label,
    value: `ours ${unit(w.ourPace)} · outside ${unit(w.outsidePace)}`,
    level: w.outsidePace > w.ourPace ? "warn" : "ok",
  })
  // id used/ceiling · ours · outside — one line per account for the active window.
  const acctLine = (a: AccountForecast, unit: typeof pctH): Row => ({
    label: name(a.account),
    value: `${pct(a.used)}/${pct(a.ceiling)} · ours ${unit(a.ourPace)} · outside ${
      a.outsidePace === undefined ? "?" : unit(a.outsidePace)
    }`,
    level:
      a.runsOutAt !== undefined && a.runsOutAt - f.now < HOUR ? "warn" : "ok",
  })
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
    burnLine("5h burn", f.five, pctH),
    ...f.fivePerAccount.map((a) => acctLine(a, pctH)),
    line("week", f.week),
    burnLine("wk burn", f.week, pctD),
    ...f.weekPerAccount.map((a) => acctLine(a, pctD)),
    ...chartLines(f, clock, names),
  ]
}

const pct = (v: number) => `${Math.round(v * 100)}%`

/**
 * Samples keyed the way forecast() matches them: by Keychain source.
 *
 * Telemetry is written under account ids, the account list the caller passes
 * is sources; without this every recent sample is dropped and the pool reads
 * as idle while it is burning.
 */
export function toSourceKeys<T extends { account: string }>(
  samples: readonly T[],
  toSource: (key: string) => string | undefined,
): T[] {
  return samples.map((s) => {
    const source = toSource(s.account)
    return source && source !== s.account ? { ...s, account: source } : s
  })
}

/**
 * The sidebar's forecast: how much is left, whether it lasts, and which
 * account is closest to empty.
 *
 * Room is counted in accounts (1.0 = one account's full window) because that
 * is how the pool is bought and how it is reasoned about; per-account rows and
 * the charts stay in forecastLines for the details view.
 */
export function forecastSummaryRows(
  f: Forecast,
  clock: (epoch: number) => string,
  names: Map<string, string> = new Map(),
): Row[] {
  const name = (a: string) => names.get(a) ?? a
  const room = (xs: AccountForecast[]) =>
    xs.reduce((t, a) => t + Math.max(0, a.ceiling - a.used), 0)
  const left = (label: string, xs: AccountForecast[]): Row => {
    const r = room(xs)
    return {
      label,
      value: `${r.toFixed(1)} of ${xs.length} account${xs.length === 1 ? "" : "s"}`,
      level: r < 0.25 ? "critical" : r < 0.75 ? "warn" : "ok",
    }
  }
  const lasts = (label: string, w: WindowForecast, unit: typeof pctH): Row =>
    f.idle
      ? { label, value: "idle, nothing burning", level: "ok" }
      : w.runsOutAt === undefined
        ? { label, value: `lasts at ${unit(w.pace)}`, level: "ok" }
        : {
            label,
            value: `runs out ~${clock(w.runsOutAt)} (in ${formatDuration(w.runsOutAt - f.now)})`,
            level: w.runsOutAt - f.now < HOUR ? "critical" : "warn",
          }

  const rows: Row[] = [
    left("5h left", f.fivePerAccount),
    lasts("5h", f.five, pctH),
    left("week left", f.weekPerAccount),
    lasts("week", f.week, pctD),
  ]

  // The usable account with the least weekly room: the next one to drop out.
  const closest = f.weekPerAccount
    .filter((a) => a.used < a.ceiling)
    .sort((a, b) => b.used / b.ceiling - a.used / a.ceiling)[0]
  if (closest)
    rows.push({
      label: "closest",
      value: `${name(closest.account)}: ${pct(closest.used)} of week used`,
      level: closest.used / closest.ceiling >= 0.9 ? "warn" : "ok",
    })

  const outside = f.five.outsidePace
  if (outside > 0.005 && outside > f.five.ourPace)
    rows.push({
      label: "others",
      value: `use ${pctH(outside)}, more than this machine`,
      level: "warn",
    })

  // The next reset that gives back real room, not one on an idle account.
  const refill = f.resets.find((r) => r.used >= 0.5)
  if (refill)
    rows.push({
      label: "next refill",
      value: `${name(refill.account)} 5h at ${clock(refill.at)}`,
    })
  return rows
}

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
