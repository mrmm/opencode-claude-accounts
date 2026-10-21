import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  latestShapes,
  workMixRows,
  composition,
  compositionRows,
  globalTotals,
  sessionRows,
  sessionTotals,
  si,
  toolGroup,
} from "./tokens.ts"

const turn = (
  input: number,
  read: number,
  write: number,
  output: number,
  cost = 0.1,
) => ({
  role: "assistant",
  cost,
  tokens: { input, output, reasoning: 0, cache: { read, write } },
})

describe("sessionTotals", () => {
  it("sums assistant turns and skips user messages and aborted turns", () => {
    const s = sessionTotals([
      { role: "user" },
      turn(10, 50_000, 2_000, 300),
      turn(0, 0, 0, 0), // aborted: billed nothing
      turn(5, 60_000, 1_000, 200),
    ])
    assert.equal(s.turns, 2)
    assert.equal(s.cacheRead, 110_000)
    assert.equal(s.lastContext, 61_005)
    assert.equal(s.avgContext, Math.round((15 + 110_000 + 3_000) / 2))
    assert.match(sessionRows(s)[1]!.value, /97% cached/)
  })
})

describe("globalTotals", () => {
  it("ranks sessions by tokens read and reports the subagent share", () => {
    const g = globalTotals([
      {
        id: "a",
        title: "main",
        input: 0,
        output: 10,
        cacheRead: 600,
        cacheWrite: 0,
        cost: 1,
      },
      {
        id: "b",
        title: "child",
        parentId: "a",
        input: 0,
        output: 5,
        cacheRead: 400,
        cacheWrite: 0,
        cost: 1,
      },
    ])
    assert.equal(g.read, 1000)
    assert.equal(g.subagentShare, 0.4)
    assert.equal(g.top[0]!.title, "main")
    assert.equal(g.top[1]!.subagent, true)
  })
})

describe("composition", () => {
  it("splits fixed prefix from conversation and groups tools by MCP server", () => {
    const c = composition({
      systemBytes: 37_000,
      toolBytes: 3_700,
      messageBytes: 7_400,
      system: [
        { bytes: 30_000, head: "# AGENTS.md — Overlord" },
        { bytes: 7_000, head: "You are Claude Code" },
      ],
      tools: [
        { name: "bash", bytes: 1_850 },
        { name: "pelico-notion_search", bytes: 925 },
        { name: "pelico-notion_fetch", bytes: 925 },
      ],
    })
    assert.equal(c.fixed, 11_000)
    assert.equal(c.blocks[0]!.head, "# AGENTS.md — Overlord")
    assert.deepEqual(
      c.toolGroups.map((g) => [g.group, g.count]),
      [
        ["bash", 1],
        ["pelico-notion", 2],
      ],
    )
    assert.match(compositionRows(c)[1]!.value, /11\.0k/)
  })

  it("counts the first user message as instructions and system messages as injected", () => {
    const c = composition({
      systemBytes: 0,
      toolBytes: 0,
      messageBytes: 37_000,
      system: [],
      tools: [],
      messages: [
        { role: "user", bytes: 18_500 },
        { role: "system", bytes: 3_700 },
        { role: "assistant", bytes: 14_800 },
      ],
    })
    assert.equal(c.instructions, 5_000)
    assert.equal(c.injected, 1_000)
    assert.equal(c.conversation, 4_000)
    assert.equal(c.fixed, 5_000)
  })

  it("names tool groups", () => {
    assert.equal(toolGroup("mcp_Read"), "Read")
    assert.equal(toolGroup("ctx_search"), "ctx")
  })
})

describe("si", () => {
  it("formats large counts", () => {
    assert.equal(si(3_024_226_301), "3.0G")
    assert.equal(si(1234), "1.2k")
    assert.equal(si(12), "12")
  })
})

import {
  chartRows,
  contextSeries,
  dailySeries,
  lineChart,
  sparkline,
} from "./tokens.ts"

describe("charts", () => {
  it("draws a sparkline, scaling to the max and bucketing long series", () => {
    assert.equal(sparkline([0, 1, 2, 4]), "▁▃▅█")
    assert.equal(sparkline([5, 5, 5, 5, 0, 0, 0, 0], 2), "█▁")
    assert.equal(sparkline([0, 0]), "▁▁")
    assert.equal(sparkline([]), "")
  })

  it("builds per-turn context and per-day reads", () => {
    assert.deepEqual(
      contextSeries([
        { role: "user" },
        turn(1, 10, 0, 1),
        turn(0, 0, 0, 0),
        turn(2, 20, 0, 1),
      ]),
      [11, 22],
    )
    const now = new Date(2026, 9, 16, 12).getTime()
    const yesterday = new Date(2026, 9, 15, 23).getTime()
    const d = dailySeries(
      [
        { updated: now, input: 1, cacheRead: 2, cacheWrite: 0 },
        { updated: yesterday, input: 0, cacheRead: 5, cacheWrite: 0 },
        {
          updated: now - 30 * 86_400_000,
          input: 99,
          cacheRead: 0,
          cacheWrite: 0,
        },
      ],
      now,
      3,
    )
    assert.deepEqual(d, [0, 5, 3])
    assert.deepEqual(
      chartRows([11, 22], d).map((r) => r.label),
      ["context", "7d read"],
    )
  })
})

describe("latestShapes", () => {
  it("keeps each session's newest request and skips a cut first line", () => {
    const shape = (sessionId: string, systemBytes: number) =>
      JSON.stringify({
        sessionId,
        systemBytes,
        toolBytes: 0,
        messageBytes: 0,
        system: [],
        tools: [],
      })
    const got = latestShapes([
      '{"cut',
      shape("a", 1),
      shape("b", 2),
      shape("a", 3),
    ])
    assert.deepEqual([...got.keys()], ["a", "b"])
    assert.equal(got.get("a")!.systemBytes, 3)
  })
})

describe("workMixRows", () => {
  it("shows money and quota, the policy's figure when it differs, and folds the tail", () => {
    const rows = workMixRows(
      {
        cost_usd: 100,
        quota_points: 10,
        policy_cost_usd: 60,
        policy_quota_points: 6,
        rows: [
          {
            class: "edit",
            steps: 5,
            cost_usd: 50,
            quota_points: 5,
            policy_cost_usd: 50,
            policy_quota_points: 5,
          },
          {
            class: "explore",
            steps: 9,
            cost_usd: 40,
            quota_points: 4,
            policy_cost_usd: 8,
            policy_quota_points: 0.8,
          },
          { class: "clarify", steps: 1, cost_usd: 10, quota_points: 1 },
        ],
      },
      2,
    )
    assert.deepEqual(rows, [
      { label: "total", value: "$100 · 10.0 pts → $60 · 6.0 pts" },
      { label: "edit", value: "$50 · 5.0 pts" },
      { label: "explore", value: "$40 · 4.0 pts → $8 · 0.8 pts" },
      { label: "1 more", value: "$10 · 1.0 pts" },
    ])
  })
})

describe("lineChart", () => {
  it("draws a rising line bottom-left to top-right, joined", () => {
    const [top, mid, bottom] = lineChart([0, 1, 2, 3, 4, 5], 3, 3)
    assert.equal(top!.length, 3)
    assert.notEqual(bottom![0], "⠀")
    assert.notEqual(top![2], "⠀")
    assert.equal(top![0], "⠀")
    // Every column has a dot somewhere: the line is continuous.
    for (let c = 0; c < 3; c++)
      assert.ok([top, mid, bottom].some((r) => r![c] !== "⠀"))
  })

  it("draws nothing for no data and a floor line for all zeros", () => {
    assert.deepEqual(lineChart([]), [])
    const rows = lineChart([0, 0, 0], 2, 2)
    assert.equal(rows[0], "⠀⠀")
    assert.equal(rows[1], "⣀⣀")
  })
})
