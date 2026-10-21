import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  activeHours,
  burnHistory,
  chartLines,
  consumed,
  forecast,
  forecastLines,
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
    assert.match(lines[3]!.value, /lasts past/)
  })
})

describe("burn charts", () => {
  it("marks each account's reset on the axis and counts it down", () => {
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
    const axis = rows.find((r) => r.value.endsWith("+5h"))!
    // 20 columns over 5h: 1h lands in column 4, 4h in column 16.
    assert.equal(axis.value[4], "2")
    assert.equal(axis.value[16], "3")
    const a = rows.find((r) => r.label === "Team 2")!
    assert.equal(a.value, "↻ HH:MM in 1h · 40%")
    assert.equal(rows.find((r) => r.label === "Team 3")!.level, "warn")
    assert.ok(rows.indexOf(a) < rows.findIndex((r) => r.label === "Team 3"))
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
    assert.equal(rows[0]!.label, "burn -5h")
    assert.match(rows[0]!.value, /50%$/)
    assert.equal(rows[1]!.label, "", "continuation rows keep the column")
    assert.equal(rows[3]!.label, "", "axis under the burn chart")
    assert.match(rows[3]!.value, /─ now$/)
    assert.equal(rows[4]!.label, "left +5h")
    assert.equal(rows[4]!.level, "critical")
  })

  it("shows a flat full pool when idle", () => {
    const quota = { a: { fiveHour: { utilization: 0, resetsAt: NOW + 3600 } } }
    const rows = chartLines(forecast([], quota as never, ["a"], NOW))
    // A full, flat pool is a line along the top row and nothing below it.
    assert.match(rows[4]!.value, /^[⠉]+ 100%$/)
    assert.match(rows[6]!.value, /^⠀+$/)
    assert.equal(rows[4]!.level, "ok")
  })
})
