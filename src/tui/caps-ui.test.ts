import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { cacheStats } from "../balance/index.ts"
import {
  accountCapRow,
  adviceRows,
  cacheSummaryRows,
  cacheViewRows,
  ceilingBar,
  ceilingPct,
  ceilingView,
  migrationPreviewRows,
  paletteTitle,
  optimizationRows,
  rankedAdvice,
  toastResult,
  toCacheRows,
  type RequestLike,
} from "./caps-ui.ts"

describe("paletteTitle", () => {
  it("spells Claude › Area › Verb", () => {
    assert.equal(
      paletteTitle("Accounts", "Manage accounts"),
      "Claude \u203a Accounts \u203a Manage accounts",
    )
  })
})

describe("toastResult", () => {
  it("names thing, result and reason", () => {
    assert.equal(
      toastResult("Preset rr-12", "not saved", "name already used"),
      "Preset rr-12 not saved: name already used",
    )
  })
  it("drops the reason when absent", () => {
    assert.equal(toastResult("Account", "enabled"), "Account enabled")
  })
})

describe("ceilingView", () => {
  it("marks reserved only when used reaches a real ceiling", () => {
    assert.equal(ceilingView(0.9, 0.8).reserved, true)
    assert.equal(ceilingView(0.7, 0.8).reserved, false)
    assert.equal(ceilingView(1, 1).reserved, false) // no ceiling set
    assert.equal(ceilingView(undefined, 0.8).reserved, false)
  })
  it("sanitises a bad ceiling to 1", () => {
    assert.equal(ceilingView(0.5, 0).ceiling, 1)
    assert.equal(ceilingView(0.5, 2).ceiling, 1)
  })
})

describe("ceilingBar", () => {
  it("fills to used and marks the ceiling", () => {
    const bar = ceilingBar(ceilingView(0.3, 0.8), 10)
    assert.equal(bar.length, 10)
    assert.equal(bar.slice(0, 3), "\u2588\u2588\u2588")
    assert.ok(bar.includes("\u250a"), "has a ceiling marker")
  })
  it("has no marker when there is no ceiling", () => {
    assert.ok(!ceilingBar(ceilingView(0.5, 1), 10).includes("\u250a"))
  })
})

describe("ceilingPct", () => {
  it("shows used over ceiling", () => {
    assert.equal(ceilingPct(ceilingView(0.62, 0.8)), "62%/80%")
    assert.equal(ceilingPct(ceilingView(0.62, 1)), "62%")
    assert.equal(ceilingPct(ceilingView(undefined, 1)), "\u2014")
  })
})

describe("accountCapRow", () => {
  it("shows id then name and a reserved marker", () => {
    const row = accountCapRow({
      id: "team-2",
      name: "Team 2",
      enabled: true,
      five: ceilingView(0.9, 0.8),
      week: ceilingView(0.4, 1),
      capMode: "hard",
    })
    assert.ok(row.label.startsWith("[x] team-2"))
    assert.ok(row.value.startsWith("Team 2"))
    assert.ok(row.value.includes("reserved (hard)"))
    assert.equal(row.level, "warn")
  })
  it("reads ok when inside the ceiling", () => {
    const row = accountCapRow({
      id: "team-1",
      name: "Team 1",
      enabled: false,
      five: ceilingView(0.3, 1),
      week: ceilingView(0.2, 1),
    })
    assert.ok(row.label.startsWith("[ ] team-1"))
    assert.equal(row.level, "ok")
  })
})

const req = (
  o: Partial<RequestLike> & { account: string; created_at: number },
): RequestLike => ({
  model: "claude-opus-4-5",
  ...o,
})

describe("toCacheRows", () => {
  it("orders by time and joins the nearest shape of the same session", () => {
    const rows = toCacheRows(
      [
        req({ account: "a", created_at: 9000, session: "s1", cacheWrite: 100 }),
        req({ account: "a", created_at: 1000, session: "s1", cacheWrite: 100 }),
      ],
      [{ sessionId: "s1", created_at: 1100, systemSha: "x", toolsSha: "y" }],
    )
    assert.equal(rows[0]!.at, 1000)
    assert.equal(rows[0]!.systemSha, "x")
    // 9000 is well past 2s from the only shape at 1100, so no join.
    assert.equal(rows[1]!.systemSha, undefined)
  })
})

describe("cacheSummaryRows", () => {
  it("summarises hit rate and the top miss causes", () => {
    const rows = toCacheRows([
      req({
        account: "a",
        created_at: 1,
        session: "s",
        cacheWrite: 1000,
        input: 0,
      }),
      req({
        account: "a",
        created_at: 2,
        session: "s",
        cacheRead: 1000,
        input: 0,
      }),
      req({
        account: "b",
        created_at: 3,
        session: "s",
        cacheWrite: 500,
        input: 0,
      }),
    ])
    const out = cacheSummaryRows(cacheStats(rows))
    assert.equal(out[0]!.label, "hit rate")
    assert.ok(
      out.some(
        (r) => r.label === "account switch" || r.label === "first request",
      ),
    )
  })
})

describe("cacheViewRows", () => {
  it("emits an all-accounts block plus per-account and per-session blocks", () => {
    const reqs = [
      req({ account: "a", created_at: 1, session: "s1", cacheRead: 100 }),
      req({ account: "b", created_at: 2, session: "s2", cacheWrite: 100 }),
    ]
    const blocks = cacheViewRows(reqs, [], new Map([["a", "Team A"]]))
    assert.equal(blocks[0]!.title, "All accounts")
    assert.ok(blocks.some((b) => b.title === "Account Team A"))
    assert.ok(blocks.some((b) => b.title.startsWith("Session ")))
  })
})

describe("rankedAdvice", () => {
  it("ranks account switches above TTL when they rewrote more, with per-day savings", () => {
    const cache = {
      hitRate: 0.5,
      reads: 0,
      writes: 0,
      uncached: 0,
      misses: [
        { at: 1, cause: "account-switch" as const, tokens: 100_000 },
        { at: 2, cause: "ttl-expired" as const, tokens: 10_000 },
      ],
    }
    const advice = rankedAdvice({ cache, spanDays: 1, windowTokens: 1_000_000 })
    assert.equal(advice[0]!.label, "account switches")
    assert.ok(advice[0]!.savedPerDay > advice[1]!.savedPerDay)
    assert.ok(advice[0]!.windowShare! > 0)
  })

  it("prices a 5m write at 1.25x the rewritten tokens", () => {
    const cache = {
      hitRate: 0,
      reads: 0,
      writes: 0,
      uncached: 0,
      misses: [{ at: 1, cause: "account-switch" as const, tokens: 1000 }],
    }
    const [a] = rankedAdvice({ cache, spanDays: 1 })
    assert.equal(a!.savedPerDay, 1250)
  })

  it("suggests context editing only when it is off and over the trigger", () => {
    const base = {
      cache: { hitRate: 1, reads: 0, writes: 0, uncached: 0, misses: [] },
      spanDays: 1,
      avgContext: 200_000,
      contextTrigger: 100_000,
    }
    assert.equal(
      rankedAdvice({ ...base, contextEditingOn: false }).some(
        (a) => a.label === "context editing",
      ),
      true,
    )
    assert.equal(rankedAdvice({ ...base, contextEditingOn: true }).length, 0)
  })

  it("returns nothing to do when clean", () => {
    assert.deepEqual(
      rankedAdvice({
        cache: { hitRate: 1, reads: 0, writes: 0, uncached: 0, misses: [] },
        spanDays: 1,
      }),
      [],
    )
  })
})

describe("adviceRows", () => {
  it("says so when there is nothing to do", () => {
    assert.equal(adviceRows([]).length, 1)
    assert.equal(adviceRows([])[0]!.level, "ok")
  })
  it("stamps each row with its per-day saving", () => {
    const rows = adviceRows([
      {
        label: "x",
        value: "y",
        savedPerDay: 1234,
        windowShare: 0.1,
        level: "warn",
      },
    ])
    assert.ok(rows[0]!.value.includes("/day"))
    assert.ok(rows[0]!.value.includes("% of window/day"))
  })
})

describe("migrationPreviewRows", () => {
  it("lists each suggested id", () => {
    const rows = migrationPreviewRows(
      [{ source: "src-abc12345", id: "team-2" }],
      new Map([["src-abc12345", "Team 2"]]),
    )
    assert.equal(rows[0]!.label, "Team 2")
    assert.ok(rows[0]!.value.includes("team-2"))
  })
  it("says so when nothing needs an id", () => {
    assert.equal(migrationPreviewRows([])[0]!.level, "ok")
  })
})

describe("optimizationRows", () => {
  const impact = {
    hitRate: 0.9,
    reads: 900,
    writes: 100,
    uncached: 0,
    misses: [],
    requests: 10,
    cost: 170,
    noCache: 1000,
    saved: 0.83,
    byCause: { "ttl-expired": { n: 2, tokens: 80 } },
    ttl1h: { requests: 0, writes: 0 },
    contextEdited: 3,
  }

  it("puts measured impact next to each setting", () => {
    const rows = optimizationRows(impact, {
      cacheTtl: "5m",
      contextEditing: { trigger: 1 },
      bindBy: "session",
      strategy: "sticky",
      capMode: "soft",
    })
    assert.match(rows[0]!.value, /90% hit.*saves 83%/)
    assert.equal(rows[1]!.label, "miss: TTL expired")
    const ttl = rows.find((r) => r.setting === "cacheTtl")!
    assert.match(ttl.value, /2 TTL misses: try auto/)
    const ce = rows.find((r) => r.setting === "contextEditing")!
    assert.equal(ce.label, "contextEditing = on (custom)")
    assert.match(ce.value, /3\/10/)
    assert.equal(rows.filter((r) => r.setting).length, 5)
  })
})
