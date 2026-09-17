import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  type UsageEvent,
  readUsage,
  record,
  recordRequest,
  summarize,
  sessionDetail,
  summarizeSessions,
  usageIndex,
} from "./usage.ts"

const T0 = 1785000000000

const req = (
  account: string,
  over: Partial<Extract<UsageEvent, { kind: "request" }>> = {},
): UsageEvent => ({
  kind: "request",
  timestamp: new Date(T0).toISOString(),
  created_at: T0,
  account,
  model: "claude-haiku-4-5",
  status: 200,
  duration_ms: 1000,
  ...over,
})

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "usage-")), "usage.jsonl")
}

describe("record + readUsage", () => {
  it("round-trips events through the file", () => {
    const path = tmpFile()
    record(req("a"), path)
    recordRequest(
      { account: "b", model: "m", status: 200, duration_ms: 5 },
      path,
    )
    const back = readUsage(0, path)
    assert.equal(back.length, 2)
    assert.equal(back[0]!.kind, "request")
  })

  it("survives a truncated final line from a crashed append", () => {
    const path = tmpFile()
    record(req("a"), path)
    writeFileSync(path, `${readFileSync(path, "utf-8")}{"kind":"request","crea`)
    const back = readUsage(0, path)
    assert.equal(back.length, 1)
  })

  it("filters by time", () => {
    const path = tmpFile()
    record(req("old", { created_at: T0 - 10_000 }), path)
    record(req("new", { created_at: T0 }), path)
    const back = readUsage(T0 - 1000, path)
    assert.deepEqual(
      back.map((e) => (e.kind === "request" ? e.account : "")),
      ["new"],
    )
  })

  it("never throws on an unwritable path", () => {
    assert.doesNotThrow(() => record(req("a"), "/proc/nope/usage.jsonl"))
  })
})

describe("summarize", () => {
  it("counts requests, refusals and other errors apart", () => {
    const s = summarize([
      req("a"),
      req("a", { status: 429 }),
      req("a", { status: 500 }),
      req("b"),
    ])
    const a = s.accounts.find((x) => x.account === "a")!
    assert.equal(a.requests, 3)
    assert.equal(a.refusals, 1)
    assert.equal(a.errors, 1)
    assert.equal(s.accounts[0]!.account, "a", "busiest account sorts first")
  })

  it("averages duration over successful requests only", () => {
    // A refusal returns fast and would flatter the average.
    const s = summarize([
      req("a", { duration_ms: 1000 }),
      req("a", { duration_ms: 3000 }),
      req("a", { status: 429, duration_ms: 1 }),
    ])
    assert.equal(s.accounts[0]!.avg_duration_ms, 2000)
  })

  it("keeps the newest utilisation rather than averaging readings", () => {
    const s = summarize([
      req("a", { created_at: T0, utilization_5h: 0.2 }),
      req("a", { created_at: T0 + 5000, utilization_5h: 0.9 }),
    ])
    assert.equal(s.accounts[0]!.utilization_5h, 0.9)
    assert.equal(s.accounts[0]!.last_used_at, T0 + 5000)
  })

  it("counts rotations by trigger", () => {
    const s = summarize([
      req("a"),
      {
        kind: "rotation",
        timestamp: new Date(T0).toISOString(),
        created_at: T0,
        from_account: "a",
        to_account: "b",
        trigger: "429",
        strategy: "sticky",
        pool: "default",
      },
      {
        kind: "rotation",
        timestamp: new Date(T0).toISOString(),
        created_at: T0,
        from_account: "b",
        to_account: "a",
        trigger: "quota-observed",
        strategy: "sticky",
        pool: "default",
      },
    ])
    assert.equal(s.rotations, 2)
    assert.deepEqual(s.by_trigger, { "429": 1, "quota-observed": 1 })
  })

  it("reduces to the index the balancer consumes", () => {
    const idx = usageIndex(summarize([req("a"), req("a"), req("b")]))
    assert.equal(idx["a"]!.requests, 2)
    assert.equal(idx["b"]!.requests, 1)
  })
})

const sessionReq = (
  session: string | undefined,
  over: Partial<{
    status: number
    ms: number
    account: string
    model: string
    at: number
  }> = {},
) => ({
  kind: "request" as const,
  timestamp: new Date(over.at ?? 1000).toISOString(),
  created_at: over.at ?? 1000,
  account: over.account ?? "a1",
  model: over.model ?? "opus",
  status: over.status ?? 200,
  duration_ms: over.ms ?? 100,
  ...(session ? { session } : {}),
})

describe("summarizeSessions", () => {
  it("totals requests, errors and average duration per session", () => {
    const rows = summarizeSessions([
      sessionReq("s1", { ms: 100 }),
      sessionReq("s1", { ms: 300, status: 400 }),
      sessionReq("s2", { ms: 50 }),
    ])
    const s1 = rows.find((r) => r.session === "s1")!
    assert.equal(s1.requests, 2)
    assert.equal(s1.errors, 1)
    assert.equal(s1.avg_ms, 200)
    assert.equal(rows.find((r) => r.session === "s2")!.requests, 1)
  })

  it("lists the distinct accounts and models a session touched", () => {
    const rows = summarizeSessions([
      sessionReq("s1", { account: "a1", model: "opus" }),
      sessionReq("s1", { account: "a2", model: "opus" }),
      sessionReq("s1", { account: "a1", model: "haiku" }),
    ])
    assert.deepEqual(rows[0]!.accounts.sort(), ["a1", "a2"])
    assert.deepEqual(rows[0]!.models.sort(), ["haiku", "opus"])
  })

  it("groups sessionless events instead of dropping them", () => {
    // Events written before the field existed, and requests with no session
    // header. Dropping them would make these totals disagree with `pnpm usage`.
    const rows = summarizeSessions([
      sessionReq(undefined),
      sessionReq(undefined),
      sessionReq("s1"),
    ])
    const unknown = rows.find((r) => r.session === "(no session)")!
    assert.equal(unknown.requests, 2)
  })

  it("orders by most recent activity", () => {
    const rows = summarizeSessions([
      sessionReq("old", { at: 10 }),
      sessionReq("new", { at: 900 }),
      sessionReq("mid", { at: 500 }),
    ])
    assert.deepEqual(
      rows.map((r) => r.session),
      ["new", "mid", "old"],
    )
  })

  it("ignores rotation events, which are not requests", () => {
    const rows = summarizeSessions([
      sessionReq("s1"),
      {
        kind: "rotation",
        timestamp: new Date(1).toISOString(),
        created_at: 1,
        from: "a1",
        to: "a2",
        trigger: "quota-observed",
      } as never,
    ])
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.requests, 1)
  })

  it("returns nothing for an empty log rather than throwing", () => {
    assert.deepEqual(summarizeSessions([]), [])
  })
})

describe("sessionDetail", () => {
  const evs = [
    sessionReq("s1", { account: "a1", ms: 100, at: 10 }),
    sessionReq("s1", { account: "a1", ms: 300, at: 20, status: 429 }),
    sessionReq("s1", { account: "a2", ms: 200, at: 30, model: "haiku" }),
    sessionReq("s2", { account: "a1", ms: 50, at: 40 }),
  ]

  it("answers null for a session with no traffic, rather than an empty shell", () => {
    assert.equal(sessionDetail(evs, "nope"), null)
  })

  it("counts only the session asked for", () => {
    const d = sessionDetail(evs, "s1")!
    assert.equal(d.requests, 3)
    assert.equal(d.errors, 1)
  })

  it("breaks errors down by status, so a 429 storm reads apart from a 500", () => {
    const d = sessionDetail(evs, "s1")!
    assert.deepEqual(
      d.byStatus.map((r) => [r.status, r.count]),
      [
        [200, 2],
        [429, 1],
      ],
    )
  })

  it("ranks accounts and models by how much they were used", () => {
    const d = sessionDetail(evs, "s1")!
    assert.deepEqual(d.byAccount, [
      { account: "a1", requests: 2 },
      { account: "a2", requests: 1 },
    ])
    assert.equal(d.byModel[0]!.model, "opus")
  })

  it("reports the worst latency, not only the average", () => {
    const d = sessionDetail(evs, "s1")!
    assert.equal(d.avg_ms, 200)
    assert.equal(d.max_ms, 300)
  })

  it("spans first to last request", () => {
    const d = sessionDetail(evs, "s1")!
    assert.equal(d.first_at, 10)
    assert.equal(d.last_at, 30)
  })

  it("reports where quota stood, per account, at the session's edges", () => {
    const withQuota = [
      { ...sessionReq("s1", { account: "a1", at: 1 }), utilization_5h: 0.2 },
      { ...sessionReq("s1", { account: "a1", at: 2 }), utilization_5h: 0.5 },
    ] as never[]
    const d = sessionDetail(withQuota, "s1")!
    assert.deepEqual(d.quotaMoves, [{ account: "a1", from: 0.2, to: 0.5 }])
  })

  it("omits an account whose quota was never observed", () => {
    const d = sessionDetail(evs, "s1")!
    assert.deepEqual(d.quotaMoves, [])
  })

  it("groups the sessionless events under the same label the list uses", () => {
    const d = sessionDetail([sessionReq(undefined, { at: 5 })], "(no session)")!
    assert.equal(d.requests, 1)
  })
})
