import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  hints,
  sessionCalls,
  toolKey,
  traffic,
  trafficRows,
} from "./traffic.ts"

describe("toolKey", () => {
  it("splits shell calls by the program they ran", () => {
    assert.equal(
      toolKey({ tool: "bash", command: "cd ~/x && git status" }),
      "$ git",
    )
    assert.equal(
      toolKey({ tool: "mcp_Shell", command: "FOO=1 /usr/bin/sqlite3 db" }),
      "$ sqlite3",
    )
    assert.equal(
      toolKey({ tool: "bash", command: "rtk git add ." }),
      "$ rtk git",
    )
    assert.equal(toolKey({ tool: "mcp_Read" }), "Read")
  })
})

describe("traffic", () => {
  it("weights outputs by how many later turns re-read them", () => {
    const t = traffic([
      { tool: "read", outBytes: 37_000, laterTurns: 10 }, // 10k tok, carried 100k
      { tool: "bash", command: "ls", outBytes: 3_700, laterTurns: 1 },
    ])
    assert.equal(t.tokens, 11_000)
    assert.equal(t.carried, 101_000)
    assert.equal(t.top[0]!.key, "read")
    assert.match(trafficRows(t, true)[0]!.value, /re-read ~101\.0k/)
  })
})

describe("sessionCalls", () => {
  it("counts assistant turns after each completed call", () => {
    const parts: Record<string, unknown[]> = {
      a1: [
        {
          type: "tool",
          tool: "bash",
          state: {
            status: "completed",
            output: "xx",
            input: { command: "git log" },
          },
        },
      ],
      a2: [
        {
          type: "tool",
          tool: "read",
          state: { status: "error", output: "nope" },
        },
        { type: "text" },
      ],
      a3: [],
    }
    const calls = sessionCalls(
      [
        { id: "u1", role: "user" },
        { id: "a1", role: "assistant" },
        { id: "a2", role: "assistant" },
        { id: "a3", role: "assistant" },
      ],
      (id) => parts[id] ?? [],
    )
    assert.deepEqual(calls, [
      { tool: "bash", command: "git log", outBytes: 2, laterTurns: 2 },
    ])
  })
})

describe("hints", () => {
  it("ranks the biggest fix first and says when nothing stands out", () => {
    assert.match(hints({})[0]!.value, /nothing stands out/)
    const rows = hints({
      composition: {
        system: 0,
        tools: 8_000,
        messages: 70_000,
        instructions: 65_000,
        injected: 0,
        conversation: 5_000,
        fixed: 73_000,
        blocks: [],
        toolGroups: [{ group: "Subagent", tokens: 3_000, count: 1 }],
      },
      traffic: traffic([
        { tool: "read", outBytes: 37_000, laterTurns: 1 },
        { tool: "read", outBytes: 37_000, laterTurns: 1 },
        { tool: "read", outBytes: 37_000, laterTurns: 1 },
      ]),
    })
    assert.equal(rows[0]!.label, "instructions")
    assert.equal(rows[1]!.label, "read")
    assert.equal(rows[2]!.label, "schema")
  })
})
