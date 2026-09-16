import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describeRequest, isCaptureLevel, readShapeFile } from "./introspect.ts"

const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    model: "claude-opus-5",
    system: [
      {
        type: "text",
        text: "You are a helpful assistant.",
        cache_control: { type: "ephemeral" },
      },
      { type: "text", text: "Project rules: always write tests." },
    ],
    tools: [
      {
        name: "read",
        description: "Read a file",
        input_schema: { type: "object" },
      },
      {
        name: "write",
        description: "Write a file",
        input_schema: { type: "object" },
      },
    ],
    messages: [
      { role: "user", content: "a secret the capture must never keep" },
      { role: "assistant", content: "ok" },
    ],
    ...over,
  })

describe("describeRequest", () => {
  it("records nothing when capture is off", () => {
    assert.equal(describeRequest(body(), "off", null), undefined)
  })

  it("never records message content, at any level", () => {
    for (const level of ["shape", "full"] as const) {
      const s = describeRequest(body(), level, "ses_1")!
      const dumped = JSON.stringify(s)
      assert.ok(
        !dumped.includes("a secret the capture must never keep"),
        `message content leaked at level ${level}`,
      )
      assert.deepEqual(
        s.messages.map((m) => m.role),
        ["user", "assistant"],
      )
    }
  })

  it("omits system text at shape level and includes it at full", () => {
    assert.equal(
      describeRequest(body(), "shape", null)!.system[0]!.text,
      undefined,
    )
    assert.match(
      describeRequest(body(), "full", null)!.system[0]!.text ?? "",
      /helpful assistant/,
    )
  })

  it("marks which blocks Anthropic was asked to cache", () => {
    const s = describeRequest(body(), "shape", null)!
    assert.equal(s.system[0]!.cached, true)
    assert.equal(s.system[1]!.cached, false)
    assert.equal(s.cachedBytes, s.system[0]!.bytes)
  })

  it("accepts a system sent as a plain string", () => {
    const s = describeRequest(
      body({ system: "flat system prompt" }),
      "full",
      null,
    )!
    assert.equal(s.system.length, 1)
    assert.equal(s.system[0]!.text, "flat system prompt")
  })

  it("gives identical blocks the same id, so repeats are countable", () => {
    const a = describeRequest(body(), "shape", null)!
    const b = describeRequest(body(), "shape", null)!
    assert.equal(a.system[0]!.sha1, b.system[0]!.sha1)
  })

  it("measures tools separately from the rest", () => {
    const s = describeRequest(body(), "shape", null)!
    assert.deepEqual(
      s.tools.map((t) => t.name),
      ["read", "write"],
    )
    assert.ok(s.toolBytes > 0)
    assert.ok(s.systemBytes > 0)
  })

  it("survives a body that is not the JSON we expect", () => {
    assert.equal(describeRequest("not json", "full", null), undefined)
    assert.doesNotThrow(() =>
      describeRequest(JSON.stringify({ model: 1 }), "full", null),
    )
  })

  it("carries the session so prompts can be grouped by conversation", () => {
    assert.equal(
      describeRequest(body(), "shape", "ses_abc")!.sessionId,
      "ses_abc",
    )
  })
})

describe("isCaptureLevel", () => {
  it("accepts only the three levels", () => {
    for (const v of ["off", "shape", "full"])
      assert.equal(isCaptureLevel(v), true)
    for (const v of ["all", "", undefined, 1])
      assert.equal(isCaptureLevel(v), false)
  })
})

describe("readShapeFile", () => {
  it("returns nothing for a file that does not exist", () => {
    const p = join(mkdtempSync(join(tmpdir(), "introspect-")), "absent.jsonl")
    assert.deepEqual(readShapeFile(p), [])
  })
})
