import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { cacheBreakdown } from "../balance/index.ts"
import {
  accountCapRow,
  adviceRows,
  breakdownRows,
  cacheBreakdownBlocks,
  requestsFromUsage,
  worstCacheAccount,
  ceilingBar,
  ceilingPct,
  ceilingView,
  migrationPreviewRows,
  paletteTitle,
  optimizationRows,
  optimizeSidebarRows,
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

describe("cache breakdown views", () => {
  const b = cacheBreakdown(
    toCacheRows(
      requestsFromUsage([
        { kind: "rotation" },
        ...[
          req({
            account: "acme-1",
            created_at: 1,
            session: "s1",
            cacheWrite: 1000,
          }),
          req({
            account: "acme-1",
            created_at: 2,
            session: "s1",
            cacheRead: 1000,
          }),
          req({
            account: "acme-2",
            created_at: 3,
            session: "s2",
            cacheWrite: 500,
          }),
        ].map((r) => ({ kind: "request", ...r })),
      ]),
    ),
    (a) => a,
  )

  it("shows all accounts, then accounts in configured order, then this session", () => {
    const blocks = cacheBreakdownBlocks(b, {
      order: ["acme-2", "acme-1"],
      names: new Map([["acme-1", "Team 1"]]),
      session: "s1",
    })
    assert.deepEqual(
      blocks.map((x) => x.title),
      ["All accounts", "Account acme-2", "Account Team 1", "This session"],
    )
    assert.equal(blocks[0]!.rows[0]!.label, "reused")
    assert.ok(blocks[3]!.rows.some((r) => r.label === "first request"))
  })

  it("names the worst account only below 80% with enough requests", () => {
    assert.deepEqual(worstCacheAccount(b, 1), { account: "acme-2", hitRate: 0 })
    assert.equal(worstCacheAccount(b, 5), undefined)
  })

  it("adds one sidebar line for the worst account", () => {
    const rows = optimizeSidebarRows({
      session: {
        turns: 1,
        cost: 0,
        lastContext: 0,
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      worstAccount: { name: "Team 2", hitRate: 0.42 },
      hints: [],
      contextLimit: 0,
    })
    const w = rows.filter((r) => r.label === "worst cache")
    assert.equal(w.length, 1)
    assert.equal(w[0]!.value, "Team 2 reuses only 42% (24h)")
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

describe("optimizeSidebarRows", () => {
  const session = {
    turns: 12,
    cost: 3.456,
    lastContext: 120_000,
    input: 1_000,
    cacheRead: 90_000,
    cacheWrite: 9_000,
  }

  it("answers spent, cache, context, re-sent and the next fix in plain words", () => {
    const rows = optimizeSidebarRows({
      session,
      cache: {
        requests: 12,
        saved: 0.85,
        byCause: {
          "first-request": { n: 1, tokens: 9_000 },
          "account-switch": { n: 2, tokens: 50_000 },
        },
      },
      composition: {
        fixed: 45_000,
        instructions: 30_000,
        tools: 12_000,
        injected: 0,
      },
      hints: [
        {
          label: "schema",
          value: "Github ~8k/turn, 30 tools: disable if unused",
          level: "warn",
        },
        { label: "hints", value: "x", level: "ok" },
      ],
      contextLimit: 200_000,
    })
    const by = Object.fromEntries(rows.map((r) => [r.label, r]))
    assert.equal(by.spent!.value, "$3.46 over 12 turns")
    assert.match(by.cache!.value, /^90% reused.*input cost 85% lower$/)
    assert.equal(by.cache!.level, "ok")
    assert.equal(by["cache miss"]!.value, "2\u00d7, mostly account switch")
    assert.equal(by.context!.value, "120k of 200k (60%)")
    assert.match(
      by["re-sent"]!.value,
      /^45k each turn \(rules 30k, tools 12k\)$/,
    )
    assert.match(by["fix next"]!.value, /^tool schemas: /)
    assert.equal(by.then, undefined, "ok-level hints are not fixes")
  })

  it("warns on a cold cache and a full context, and says when nothing stands out", () => {
    const rows = optimizeSidebarRows({
      session: {
        ...session,
        lastContext: 170_000,
        cacheRead: 10_000,
        cacheWrite: 80_000,
      },
      hints: [],
      contextLimit: 0,
    })
    const by = Object.fromEntries(rows.map((r) => [r.label, r]))
    assert.equal(by.cache!.level, "warn")
    assert.equal(by.context!.value, "170k, compact now")
    assert.equal(by.context!.level, "warn")
    assert.equal(by["fix next"]!.value, "nothing stands out")
  })

  it("has one row before the first turn", () => {
    const rows = optimizeSidebarRows({
      session: { ...session, turns: 0 },
      hints: [],
      contextLimit: 0,
    })
    assert.deepEqual(rows, [{ label: "session", value: "no turns yet" }])
  })
})

describe("breakdownRows", () => {
  it("says so when there is nothing to show", () => {
    assert.deepEqual(
      breakdownRows({
        requests: 0,
        hitRate: 0,
        saved: 0,
        misses: 0,
        byCause: {},
      }),
      [{ label: "requests", value: "none with token data yet" }],
    )
  })
})
