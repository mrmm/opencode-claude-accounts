import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  activeHours,
  burnHistory,
  chartLines,
  consumed,
  forecast,
  forecastLines,
  outsideBurn,
  simulate,
} from "./forecast.ts"

const NOW = 1_800_000_000 // unix s
const at = (minAgo: number) => (NOW - minAgo * 60) * 1000

describe("consumed", () => {
  it("sums rises per account and ignores a window turning over", () => {
    const s = [
      { account: "a", at: at(50), u5: 0.2 },
      { account: "a", at: at(40), u5: 0.3 },
      { account: "a", at: at(30), u5: 0.05 }, // reset: not negative use
      { account: "a", at: at(20), u5: 0.15 },
      { account: "b", at: at(45), u5: 0.5 },
      { account: "b", at: at(10), u5: 0.6 },
    ]
    assert.equal(consumed(s, "u5", at(60), at(0)).toFixed(2), "0.30")
  })

  it("does not pair across accounts", () => {
    const s = [
      { account: "a", at: at(20), u5: 0.9 },
      { account: "b", at: at(10), u5: 0.1 },
      { account: "a", at: at(5), u5: 0.95 },
    ]
    assert.equal(consumed(s, "u5", at(30), at(0)).toFixed(2), "0.05")
  })
})

describe("activeHours", () => {
  it("counts 10-minute buckets with a request, not wall-clock", () => {
    const s = [at(600), at(599), at(30)].map((t) => ({ account: "a", at: t }))
    assert.equal(
      activeHours(s, at(700), at(0)).toFixed(3),
      (20 / 60).toFixed(3),
    )
  })
})

describe("simulate", () => {
  it("runs out when the pace outruns the room before any reset", () => {
    const out = simulate(
      [{ used: 0.5, period: 18000, blocked: false }],
      1,
      NOW,
      NOW + 18000,
    )
    assert.ok(
      out !== undefined && out - NOW >= 1800 && out - NOW <= 2100,
      `out=${out! - NOW}`,
    )
  })

  it("lasts when a reset refills the account in time", () => {
    const slots = [
      { used: 0.9, resetsAt: NOW + 600, period: 18000, blocked: false },
    ]
    assert.equal(simulate(slots, 0.5, NOW, NOW + 3600), undefined)
  })

  it("skips an account that cannot serve", () => {
    const slots = [
      { used: 0, period: 18000, blocked: true },
      { used: 0.9, period: 18000, blocked: false },
    ]
    assert.ok(simulate(slots, 1, NOW, NOW + 7200) !== undefined)
  })
})

describe("forecast", () => {
  const quota = {
    a: {
      fiveHour: { utilization: 0.4, resetsAt: NOW + 3 * 3600 },
      sevenDay: { utilization: 0.7, resetsAt: NOW + 4 * 86400 },
    },
    b: {
      fiveHour: { utilization: 0.2, resetsAt: NOW + 3600 },
      sevenDay: { utilization: 0.5, resetsAt: NOW + 5 * 86400 },
    },
    gone: {
      fiveHour: { utilization: 0 },
      sevenDay: { utilization: 1, resetsAt: NOW + 86400 },
    },
  } as never

  it("flags a spike against the typical working pace", () => {
    const s = [
      // yesterday: steady 10%/h over two working hours
      ...Array.from({ length: 13 }, (_, i) => ({
        account: "a",
        at: at(1500 - i * 10),
        u5: 0.1 + i * (0.2 / 12),
      })),
      // last 30 min: +30% => 60%/h
      { account: "b", at: at(29), u5: 0.0 },
      { account: "b", at: at(1), u5: 0.3 },
    ]
    const f = forecast(s, quota, ["a", "b"], NOW)
    assert.ok(f.nowPace > 0.55 && f.nowPace < 0.65, `now ${f.nowPace}`)
    assert.ok(f.spike !== undefined && f.spike > 1.5, `spike ${f.spike}`)
  })

  it("an account out of weekly quota adds no 5h room", () => {
    const burst = [
      { account: "gone", at: at(29), u5: 0 },
      { account: "a", at: at(29), u5: 0.0 },
      { account: "a", at: at(1), u5: 1.0 }, // 200%/h
    ]
    const withGone = forecast(burst, quota, ["a", "gone"], NOW)
    assert.ok(withGone.five.runsOutAt !== undefined)
    assert.ok(
      withGone.five.runsOutAt! - NOW < 3600,
      "0.6 left at 2.0/h is ~18 min",
    )
  })

  it("idle means no 5h forecast, and lines say so", () => {
    const f = forecast([], quota, ["a", "b"], NOW)
    assert.equal(f.idle, true)
    const lines = forecastLines(f, (e) => String(e - NOW))
    assert.equal(lines[0]!.value, "idle")
    assert.match(lines[2]!.value, /idle/)
    const week = lines.find((l) => l.label === "week")
    assert.match(week!.value, /^✓ lasts >7d · past /)
  })

  it("says how long the pool lasts and when it runs out", () => {
    const burst = [
      { account: "a", at: at(29), u5: 0.0 },
      { account: "a", at: at(1), u5: 1.0 }, // 200%/h
    ]
    const f = forecast(burst, quota, ["a", "b"], NOW)
    const lines = forecastLines(f, (e) => `T${e - NOW}`)
    assert.match(lines[2]!.value, /^✗ out in \d+m · ~T\d+$/)
    assert.equal(lines[2]!.level, "critical", "under an hour left")
  })
})

describe("burn charts", () => {
  it("marks each account's reset on the axis", () => {
    const quota = {
      a: { fiveHour: { utilization: 0.4, resetsAt: NOW + 3600 } },
      b: { fiveHour: { utilization: 0.97, resetsAt: NOW + 4 * 3600 } },
    }
    const names = new Map([
      ["a", "Team 2"],
      ["b", "Team 3"],
    ])
    const f = forecast([], quota as never, ["a", "b"], NOW)
    const rows = chartLines(f, () => "HH:MM", names)
    const axes = rows.filter((r) => r.value.endsWith("┘"))
    assert.equal(axes.length, 2, "one axis under each chart")
    const axis = axes[1]!
    // 20 columns over 5h: 1h lands in column 4, 4h in column 16.
    assert.equal(axis.value[4], "2")
    assert.equal(axis.value[16], "3")
    // Countdowns live in the accounts block; the charts only mark the resets.
    assert.ok(!rows.some((r) => r.value.includes("↻")))
  })

  it("books each rise to the bucket of the response that carried it", () => {
    const s = [
      { account: "a", at: at(290), u5: 0.1 }, // baseline, no rise
      { account: "a", at: at(200), u5: 0.3 }, // +0.2, straddles buckets
      { account: "a", at: at(100), u5: 0.05 }, // reset, not use
      { account: "a", at: at(5), u5: 0.25 }, // +0.2, last bucket
    ]
    const h = burnHistory(s, at(0), 300 * 60 * 1000, 10)
    assert.equal(h.length, 10)
    assert.equal(h[3]!.toFixed(2), "0.20")
    assert.equal(h[9]!.toFixed(2), "0.20")
    assert.equal(h.reduce((a, v) => a + v, 0).toFixed(2), "0.40")
  })

  it("projects the pool draining to zero and flags it", () => {
    const quota = {
      a: { fiveHour: { utilization: 0.5, resetsAt: NOW + 10 * 3600 } },
    }
    const samples = [
      { account: "a", at: at(30), u5: 0.0 },
      { account: "a", at: at(0), u5: 0.5 }, // 100%/h
    ]
    const f = forecast(samples, quota as never, ["a"], NOW)
    assert.ok(f.ahead[0]! < 0.5, "room shrinks from the first step")
    assert.equal(f.ahead[f.ahead.length - 1], 0)
    const rows = chartLines(f)
    // Burn: 50% in the last bucket of 15 minutes is 200%/h at the top of scale.
    assert.equal(rows[0]!.label, "burn %/h")
    assert.match(rows[0]!.value, / 200$/)
    assert.equal(rows[1]!.label, "total 50%")
    assert.match(rows[2]!.value, / 0$/, "scale floor on the bottom row")
    assert.equal(rows[0]!.tone, "burn")
    assert.match(rows[3]!.value, /^─+┘$/)
    assert.equal(rows[3]!.tone, "axis")
    assert.equal(rows[5]!.label, "left %")
    assert.equal(rows[6]!.label, "at end 0%")
    assert.equal(rows[5]!.level, "critical")
    assert.equal(rows[5]!.tone, "projection")
  })

  it("shows a flat full pool when idle", () => {
    const quota = { a: { fiveHour: { utilization: 0, resetsAt: NOW + 3600 } } }
    const rows = chartLines(
      forecast([], quota as never, ["a"], NOW),
      (t) => `t${(t - NOW) / 3600}`,
    )
    // A full, flat pool is a line along the top row and nothing below it.
    assert.match(rows[5]!.value, /^[⠉]+ 100$/)
    assert.match(rows[7]!.value, /^⠀+ 0$/)
    assert.equal(rows[5]!.level, "ok")
    // Clock ticks at the start, middle and end of each span.
    assert.match(rows[4]!.value, /^t-5 +t-2.5 +t0$/)
    assert.match(rows[9]!.value, /^t0 +t2.5 +t5$/)
  })
})

describe("ceilings", () => {
  const quota = {
    a: {
      fiveHour: { utilization: 0.5, resetsAt: NOW + 10 * 3600 },
      sevenDay: { utilization: 0.3, resetsAt: NOW + 10 * 86400 },
    },
  } as never
  // Steady 100%/h over the last half hour.
  const burst = [
    { account: "a", at: at(30), u5: 0.0 },
    { account: "a", at: at(0), u5: 0.5 },
  ]

  it("a lower ceiling runs the pool out sooner", () => {
    const full = forecast(burst, quota, ["a"], NOW)
    const capped = forecast(burst, quota, ["a"], NOW, {
      ceilings: { a: { five: 0.7, week: 1 } },
    })
    assert.ok(full.five.runsOutAt !== undefined)
    assert.ok(capped.five.runsOutAt !== undefined)
    // 0.5 used, 100%/h: full window has 0.5 left (~30 min), ceiling 0.7 has
    // 0.2 left (~12 min).
    assert.ok(
      capped.five.runsOutAt! < full.five.runsOutAt!,
      `capped ${capped.five.runsOutAt! - NOW} vs full ${full.five.runsOutAt! - NOW}`,
    )
  })

  it("reserveLeft is what sits above the ceilings for outside users", () => {
    const f = forecast(burst, quota, ["a"], NOW, {
      ceilings: { a: { five: 0.7, week: 0.8 } },
    })
    // used 0.5, ceiling 0.7 => 1 - 0.7 = 0.3 reserve above the ceiling.
    assert.equal(f.five.reserveLeft.toFixed(2), "0.30")
    // used 0.3, ceiling 0.8 => 0.2 reserve.
    assert.equal(f.week.reserveLeft.toFixed(2), "0.20")
  })

  it("per-account lines carry used/ceiling", () => {
    const f = forecast(burst, quota, ["a"], NOW, {
      ceilings: { a: { five: 0.7, week: 0.8 } },
    })
    assert.equal(f.fivePerAccount[0]!.ceiling, 0.7)
    assert.equal(f.fivePerAccount[0]!.used, 0.5)
    const lines = forecastLines(f, (e) => `T${e - NOW}`, new Map([["a", "A1"]]))
    const acct = lines.find((l) => l.label === "A1")
    assert.match(acct!.value, /^50%\/70% · ours /)
  })
})

describe("outsideBurn", () => {
  // Our own tokens move the gauge at a learned ratio; here 1e-6 per token.
  const k = 1e-6
  const ours = (
    minAgo: number,
    u5: number,
    tok: number,
  ): {
    account: string
    at: number
    u5: number
    reqs: number
    input: number
  } => ({
    account: "a",
    at: at(minAgo),
    u5,
    reqs: 1,
    input: tok,
  })

  it("detects a rise in an idle bucket as pure outside burn", () => {
    // Ten buckets of our own traffic to learn k, then two idle buckets whose
    // gauge still climbs: that climb is someone else on the subscription.
    const learn = Array.from({ length: 10 }, (_, i) =>
      ours(300 - i * 10, i * k * 1e5, 1e5),
    )
    const idle = [
      { account: "a", at: at(60), u5: learn[9]!.u5, reqs: 0, input: 0 },
      { account: "a", at: at(0), u5: learn[9]!.u5 + 0.1, reqs: 0, input: 0 },
    ]
    const b = outsideBurn([...learn, ...idle], NOW)
    assert.ok(b["a"]!.five.pace !== undefined, "enough buckets to estimate")
    assert.ok(b["a"]!.five.pace! > 0, `outside pace ${b["a"]!.five.pace}`)
  })

  it("separates our share from the outside when both burn", () => {
    // Each bucket: our 1e5 tokens explain k*1e5 = 0.1; the gauge rises 0.15, so
    // 0.05 per bucket is outside.
    const rows = Array.from({ length: 12 }, (_, i) => ({
      account: "a",
      at: at(300 - i * 20),
      u5: i * 0.15,
      reqs: 1,
      input: 1e5,
    }))
    const b = outsideBurn(rows, NOW)
    const p = b["a"]!.five.pace
    assert.ok(p !== undefined && p > 0, `pace ${p}`)
    // Residual ~ 0.05/bucket, 11 rises over 5h => positive but well under the
    // raw 0.15/bucket gross rise.
    const gross = (0.15 * 11) / 5
    assert.ok(p! < gross, `outside ${p} should be below gross ${gross}`)
  })

  it("is unknown with too few token-bearing buckets, and forecast still runs", () => {
    const rows = [
      { account: "a", at: at(20), u5: 0.1, reqs: 1, input: 1e5 },
      { account: "a", at: at(10), u5: 0.2, reqs: 1, input: 1e5 },
    ]
    const b = outsideBurn(rows, NOW)
    // Fewer than MIN_OUTSIDE_BUCKETS window buckets => unknown.
    assert.equal(b["a"]!.five.pace, undefined)
    const quota = {
      a: { fiveHour: { utilization: 0.4, resetsAt: NOW + 3 * 3600 } },
    } as never
    const f = forecast(rows, quota, ["a"], NOW)
    assert.equal(f.five.outsidePace, 0, "unknown burn contributes nothing")
    assert.equal(f.fivePerAccount[0]!.outsidePace, undefined)
    const lines = forecastLines(
      f,
      (e) => String(e - NOW),
      new Map([["a", "A1"]]),
    )
    assert.match(lines.find((l) => l.label === "A1")!.value, /outside \?$/)
  })

  it("the weekly horizon learns from the full 8-day span", () => {
    // Daily outside rise in u7 across eight days, no traffic of ours.
    const rows = Array.from({ length: 8 }, (_, i) => ({
      account: "a",
      at: NOW * 1000 - (7 - i) * 86_400_000,
      u7: i * 0.05,
      reqs: 0,
      input: 0,
    }))
    const b = outsideBurn(rows, NOW)
    assert.ok(b["a"]!.week.pace !== undefined, "eight buckets over the week")
    assert.ok(b["a"]!.week.pace! > 0, `week pace ${b["a"]!.week.pace}`)
  })
})
