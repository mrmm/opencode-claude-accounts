import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { cacheStats, type CacheRow } from "./cache-stats.ts"

const T0 = 1785000000000

const row = (over: Partial<CacheRow> = {}): CacheRow => ({
  at: T0,
  account: "a",
  model: "claude-opus-5",
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  ...over,
})

describe("cacheStats hitRate", () => {
  it("is reads over all cacheable input", () => {
    const s = cacheStats([
      row({ input: 100, cacheRead: 900, cacheWrite: 0 }),
      row({ input: 0, cacheRead: 1000, cacheWrite: 0, at: T0 + 1000 }),
    ])
    // reads 1900 / (uncached 100 + reads 1900 + writes 0) = 0.95
    assert.equal(s.reads, 1900)
    assert.equal(s.writes, 0)
    assert.equal(s.uncached, 100)
    assert.ok(Math.abs(s.hitRate - 0.95) < 1e-9)
  })

  it("is zero when nothing is cacheable", () => {
    assert.equal(cacheStats([row(), row()]).hitRate, 0)
  })

  it("counts both 5m and 1h writes", () => {
    const s = cacheStats([row({ input: 10, cacheWrite: 30, cacheWrite1h: 70 })])
    assert.equal(s.writes, 100)
  })
})

describe("cacheStats miss causes", () => {
  const miss = (rows: CacheRow[]) => cacheStats(rows).misses

  it("labels the first cacheable request first-request", () => {
    const m = miss([row({ input: 100, cacheWrite: 5000, cacheRead: 0 })])
    assert.deepEqual(
      m.map((x) => x.cause),
      ["first-request"],
    )
    assert.equal(m[0]!.tokens, 5000)
  })

  it("labels a switched account account-switch", () => {
    const m = miss([
      row({ account: "a", input: 10, cacheWrite: 1000 }),
      row({
        account: "b",
        input: 10,
        cacheWrite: 1000,
        cacheRead: 0,
        at: T0 + 100,
      }),
    ])
    assert.equal(m[1]!.cause, "account-switch")
  })

  it("labels a changed model model-change", () => {
    const m = miss([
      row({ model: "claude-opus-5", input: 10, cacheWrite: 1000 }),
      row({
        model: "claude-haiku-5",
        input: 10,
        cacheWrite: 1000,
        at: T0 + 100,
      }),
    ])
    assert.equal(m[1]!.cause, "model-change")
  })

  it("labels an idle gap beyond the TTL ttl-expired", () => {
    const m = miss([
      row({ input: 10, cacheWrite: 1000, ttl: "5m" }),
      row({ input: 10, cacheWrite: 1000, ttl: "5m", at: T0 + 6 * 60_000 }),
    ])
    assert.equal(m[1]!.cause, "ttl-expired")
  })

  it("respects a 1h TTL before calling it expired", () => {
    const within1h = miss([
      row({ input: 10, cacheWrite1h: 1000, ttl: "1h", systemSha: "x" }),
      row({
        input: 10,
        cacheWrite1h: 1000,
        ttl: "1h",
        systemSha: "x",
        at: T0 + 40 * 60_000,
      }),
    ])
    assert.notEqual(within1h[1]!.cause, "ttl-expired")
  })

  it("labels a changed prefix within TTL prefix-change", () => {
    const m = miss([
      row({ input: 10, cacheWrite: 1000, systemSha: "aaa", toolsSha: "t1" }),
      row({
        input: 10,
        cacheWrite: 1000,
        systemSha: "bbb",
        toolsSha: "t1",
        at: T0 + 1000,
      }),
    ])
    assert.equal(m[1]!.cause, "prefix-change")
  })

  it("labels a shrinking prefix change compaction", () => {
    const m = miss([
      row({ input: 5000, cacheRead: 0, cacheWrite: 1000, systemSha: "aaa" }),
      row({
        input: 100,
        cacheRead: 0,
        cacheWrite: 1000,
        systemSha: "bbb",
        at: T0 + 1000,
      }),
    ])
    assert.equal(m[1]!.cause, "compaction")
  })

  it("does not flag a warm request as a miss", () => {
    const m = miss([
      row({ input: 10, cacheWrite: 2000, systemSha: "x" }),
      // big read, tiny write -> warm, not a miss
      row({
        input: 10,
        cacheRead: 5000,
        cacheWrite: 50,
        systemSha: "x",
        at: T0 + 1000,
      }),
    ])
    assert.deepEqual(
      m.map((x) => x.cause),
      ["first-request"],
    )
  })
})
