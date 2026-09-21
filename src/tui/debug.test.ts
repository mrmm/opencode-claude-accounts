import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { debugReport, type DebugInput } from "./debug.ts"

const NOW = 1_700_000_000

const base: DebugInput = {
  build: "2.1.4+abc1234",
  selection: "preset:rr-123",
  accounts: [{ source: "s1", label: "Team 1" }],
  quota: {},
  presets: {},
  config: { strategy: "round-robin", useCredits: true },
  now: NOW,
}

describe("debugReport", () => {
  it("leads with the build, because a stale one explains most surprises", () => {
    assert.match(debugReport(base), /^build\s+2\.1\.4\+abc1234/)
  })

  it("distinguishes no reading from a bad reading", () => {
    // They look identical in the sidebar and are different problems.
    assert.match(debugReport(base), /no reading/)
  })

  it("says when the credit state is unknown rather than implying it is off", () => {
    const q = {
      s1: {
        fiveHour: { utilization: 1 },
        sevenDay: { utilization: 0.5 },
        observedAt: NOW - 600,
      },
    } as unknown as DebugInput["quota"]
    const r = debugReport({ ...base, quota: q })
    assert.match(r, /credits   UNKNOWN/)
    assert.match(r, /observed 10m ago/)
  })

  it("reports the spend and the binding limit when a probe has landed", () => {
    const q = {
      s1: {
        fiveHour: { utilization: 1, status: "rejected" },
        sevenDay: { utilization: 0.75 },
        observedAt: NOW,
        extra: {
          enabled: true,
          capReached: false,
          usedMinor: 11378,
          limitMinor: 20000,
          currency: "EUR",
        },
        activeLimits: [
          { kind: "weekly_all", percent: 100, severity: "critical" },
        ],
      },
    } as unknown as DebugInput["quota"]
    const r = debugReport({ ...base, quota: q })
    assert.match(r, /spent=113\.78 EUR of 200\.00 EUR/)
    assert.match(r, /binding   weekly_all at 100% \(critical\)/)
  })

  it("lists a tiered preset tier by tier", () => {
    const r = debugReport({
      ...base,
      presets: {
        t: {
          pools: [
            { name: "primary", accounts: ["Team 1"] },
            { name: "reserve", accounts: [] },
          ],
        },
      },
    })
    assert.match(r, /t — 2 tiers/)
    assert.match(r, /1\. primary: Team 1/)
    assert.match(r, /2\. reserve: empty/)
  })

  it("names references that resolve to nothing", () => {
    // The failure that cost a two-day wait: a preset quietly one account short.
    const r = debugReport({ ...base, unresolved: ["Team 3"] })
    assert.match(r, /Team 3 — matches no account/)
  })
})
