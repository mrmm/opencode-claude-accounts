import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { RequestEvent, UsageEvent } from "../balance/index.ts"
import {
  describeStep,
  recentRequests,
  requestListRow,
  requestTrace,
} from "./requests.ts"

const names: Record<string, string> = { "acme-1": "Team 1", "acme-2": "Team 2" }
const nameOf = (id: string) => names[id] ?? id

const req = (over: Partial<RequestEvent> = {}): RequestEvent => ({
  kind: "request",
  timestamp: "",
  created_at: 1_000,
  account: "acme-1",
  model: "claude-opus-4-8",
  status: 200,
  duration_ms: 3_200,
  ...over,
})

describe("request trace", () => {
  it("lists request rows newest first, one session when asked", () => {
    const events: UsageEvent[] = [
      req({ created_at: 1, session: "a" }),
      req({ created_at: 3, session: "b" }),
      {
        kind: "rotation",
        timestamp: "",
        created_at: 2,
        from_account: null,
        to_account: "acme-2",
        trigger: "t",
        strategy: "s",
        pool: "p",
      },
      req({ created_at: 2, session: "a" }),
    ]
    assert.deepEqual(
      recentRequests(events).map((e) => e.created_at),
      [3, 2, 1],
    )
    assert.deepEqual(
      recentRequests(events, { session: "a", limit: 1 }).map(
        (e) => e.created_at,
      ),
      [2],
    )
  })

  it("summarises a row with tokens, cache share and what happened", () => {
    const r = requestListRow(
      req({
        input: 1_000,
        cacheRead: 9_000,
        output: 500,
        steps: ["active", "rotate:acme-1>acme-2", "status:200"],
      }),
      nameOf,
    )
    assert.match(r.title, /Team 1 {2}opus-4-8 {2}200$/)
    assert.equal(
      r.description,
      "10.0k in · 500 out · 90% cached · 3.2s · rotated",
    )
  })

  it("turns steps into the path, naming accounts", () => {
    assert.equal(
      describeStep("rotate:acme-1>acme-2", nameOf),
      "429: Team 1 refused, moved to Team 2 and retried",
    )
    assert.equal(
      describeStep("beta-off:context-1m", nameOf),
      "400/429 long context: beta context-1m excluded, retried",
    )
    assert.equal(describeStep("new-thing", nameOf), "new-thing")
    const lines = requestTrace(
      req({ steps: ["bound", "ctx-edit", "status:200"], utilization_5h: 0.42 }),
      nameOf,
    )
    assert.deepEqual(
      lines.filter((l) => l.section === "Path").map((l) => l.text),
      [
        "account: the one bound to this session",
        "context editing added (old tool results may be cleared)",
        "answered 200",
      ],
    )
    assert.ok(lines.some((l) => l.text === "Team 1: 5h 42%"))
  })

  it("says so for a row logged before traces existed", () => {
    const lines = requestTrace(req(), nameOf)
    assert.ok(
      lines.some((l) => l.section === "Path" && /not recorded/.test(l.text)),
    )
  })
})
