import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  activeHours,
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
