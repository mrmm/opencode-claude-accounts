import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  cacheBreakdown,
  cacheImpact,
  cacheStats,
  topCause,
  type CacheRow,
} from "./cache-stats.ts"

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

describe("cacheImpact", () => {
  it("prices reads, 5m and 1h writes and groups misses by cause", () => {
    const i = cacheImpact([
      row({ input: 0, output: 0, cacheWrite: 1000 }),
      row({ at: T0 + 1000, cacheRead: 1000, ttl: "1h", cacheWrite1h: 100 }),
      row({
        at: T0 + 2000,
        model: "claude-sonnet-5",
        cacheRead: 1000,
        contextEdited: true,
      }),
      row({ at: T0 + 3000 }),
    ])
    assert.equal(i.requests, 3, "rows without tokens are skipped")
    // 1.25*1000 + (0.05*1000 + 2*100) + 0.1*1000
    assert.equal(i.cost, 1250 + 250 + 100)
    assert.equal(i.noCache, 3100)
    assert.ok(Math.abs(i.saved - (1 - 1600 / 3100)) < 1e-9)
    assert.deepEqual(i.byCause, { "first-request": { n: 1, tokens: 1000 } })
    assert.deepEqual(i.ttl1h, { requests: 1, writes: 100 })
    assert.equal(i.contextEdited, 1)
  })

  it("classifies misses within each session", () => {
    const i = cacheImpact([
      row({ session: "s1", account: "a", cacheWrite: 10 }),
      row({ session: "s2", account: "b", at: T0 + 1, cacheWrite: 10 }),
      row({ session: "s1", account: "a", at: T0 + 2, cacheRead: 100 }),
    ])
    assert.deepEqual(i.byCause, { "first-request": { n: 2, tokens: 20 } })
  })

  it("is all zero with no data", () => {
    const i = cacheImpact([])
    assert.equal(i.saved, 0)
    assert.equal(i.requests, 0)
  })
})

describe("cacheBreakdown", () => {
  const rows = [
    row({ account: "src-1", session: "s1", cacheWrite: 1000 }),
    row({
      account: "src-2",
      session: "s2",
      at: T0 + 500,
      cacheRead: 900,
      input: 100,
    }),
    row({ account: "src-1", session: "s1", at: T0 + 1000, cacheRead: 1000 }),
    // s1 moves to src-2: an account switch, charged to src-2 and s1.
    row({ account: "src-2", session: "s1", at: T0 + 2000, cacheWrite: 1200 }),
    row({ account: "acme-1", session: "s1", at: T0 + 3000, cacheRead: 1200 }),
    row({ account: "src-1", at: T0 + 4000 }),
  ]
  const ids: Record<string, string> = { "src-1": "acme-1", "src-2": "acme-2" }
  const b = cacheBreakdown(rows, (a) => ids[a] ?? a)

  it("matches cacheImpact globally", () => {
    const ci = cacheImpact(rows)
    assert.equal(b.global.requests, ci.requests)
    assert.ok(Math.abs(b.global.hitRate - ci.hitRate) < 1e-9)
    assert.ok(Math.abs(b.global.saved - ci.saved) < 1e-9)
    assert.deepEqual(b.global.byCause, ci.byCause)
  })

  it("buckets accounts by id, so a source and its id land together", () => {
    assert.deepEqual(
      b.accounts.map((a) => [a.account, a.requests, a.misses]),
      [
        ["acme-1", 3, 1],
        ["acme-2", 2, 1],
      ],
    )
    const two = b.accounts.find((a) => a.account === "acme-2")!
    assert.deepEqual(two.byCause, { "account-switch": { n: 1, tokens: 1200 } })
    assert.ok(Math.abs(two.hitRate - 900 / 2200) < 1e-9)
  })

  it("lists sessions by misses, skipping rows with no session", () => {
    assert.deepEqual(
      b.sessions.map((s) => [s.session, s.requests, s.misses]),
      [
        ["s1", 4, 2],
        ["s2", 1, 0],
      ],
    )
    assert.equal(topCause(b.sessions[0]!), "account-switch")
    assert.equal(topCause(b.sessions[1]!), undefined)
  })
})
