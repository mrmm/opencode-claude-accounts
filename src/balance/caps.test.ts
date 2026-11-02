import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { AccountId, ClaudeAuthConfig } from "../config.ts"
import { ceilingFor, effectiveLimit } from "./caps.ts"

const cfg = (
  accountIds: Record<string, AccountId>,
  switchAt = 0.95,
): Pick<ClaudeAuthConfig, "accountIds" | "switchAt"> => ({
  accountIds,
  switchAt,
})

const ids: Record<string, AccountId> = {
  a: { match: { account: "a", org: "o" }, maxUsage: { "5h": 0.8, "7d": 0.6 } },
  b: { match: { account: "b", org: "o" }, maxUsage: { "7d": 0.5 } },
  c: { match: { account: "c", org: "o" } },
}

describe("ceilingFor", () => {
  it("returns the configured ceiling", () => {
    assert.equal(ceilingFor(cfg(ids), "a", "5h"), 0.8)
    assert.equal(ceilingFor(cfg(ids), "a", "7d"), 0.6)
  })
  it("is 1 for a window with no ceiling", () => {
    assert.equal(ceilingFor(cfg(ids), "b", "5h"), 1)
    assert.equal(ceilingFor(cfg(ids), "c", "7d"), 1)
    assert.equal(ceilingFor(cfg(ids), "missing", "5h"), 1)
  })
})

describe("effectiveLimit", () => {
  it("is the lower of switchAt and the ceiling", () => {
    assert.equal(effectiveLimit(cfg(ids, 0.95), "a", "5h"), 0.8)
    assert.equal(effectiveLimit(cfg(ids, 0.5), "a", "5h"), 0.5)
  })
  it("falls back to switchAt when there is no ceiling", () => {
    assert.equal(effectiveLimit(cfg(ids, 0.95), "c", "5h"), 0.95)
  })
})
