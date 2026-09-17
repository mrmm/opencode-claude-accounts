import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { isPrefillError, stripTrailingAssistant } from "./prefill.ts"

const body = (roles: string[]) =>
  JSON.stringify({
    model: "claude-opus-5",
    max_tokens: 100,
    messages: roles.map((role) => ({ role, content: `${role} text` })),
  })

describe("isPrefillError", () => {
  it("recognises the refusal this exists for", () => {
    assert.equal(
      isPrefillError(
        "This model does not support assistant message prefill. The conversation must end with a user message.",
      ),
      true,
    )
  })

  it("does not fire on other 400s", () => {
    for (const other of [
      "Extra usage is required for long context requests",
      "invalid_request_error: max_tokens is too large",
      "",
    ]) {
      assert.equal(isPrefillError(other), false, other)
    }
  })
})

describe("stripTrailingAssistant", () => {
  it("reports how many turns it dropped", () => {
    assert.equal(
      stripTrailingAssistant(body(["user", "assistant"]))!.dropped,
      1,
    )
  })

  it("drops the trailing assistant turn", () => {
    const out = stripTrailingAssistant(
      body(["user", "assistant", "user", "assistant"]),
    )
    const roles = JSON.parse(out!.body).messages.map(
      (m: { role: string }) => m.role,
    )
    assert.deepEqual(roles, ["user", "assistant", "user"])
  })

  it("drops a run of trailing assistant turns, not just one", () => {
    const out = stripTrailingAssistant(body(["user", "assistant", "assistant"]))
    assert.deepEqual(
      JSON.parse(out!.body).messages.map((m: { role: string }) => m.role),
      ["user"],
    )
    assert.equal(out!.dropped, 2, "the count is what makes the log actionable")
  })

  it("preserves every other field of the request", () => {
    const out = JSON.parse(
      stripTrailingAssistant(body(["user", "assistant"]))!.body,
    )
    assert.equal(out.model, "claude-opus-5")
    assert.equal(out.max_tokens, 100)
  })

  it("does nothing when the conversation already ends with a user turn", () => {
    assert.equal(
      stripTrailingAssistant(body(["user", "assistant", "user"])),
      null,
    )
  })

  it("refuses to empty the conversation", () => {
    // Stripping here would send zero messages: a worse error than the one being
    // recovered from, and impossible to diagnose from the response.
    assert.equal(stripTrailingAssistant(body(["assistant"])), null)
    assert.equal(stripTrailingAssistant(body(["assistant", "assistant"])), null)
  })

  it("returns null on anything it cannot parse or understand", () => {
    for (const junk of [
      "not json",
      "null",
      '"a string"',
      "{}",
      '{"messages":"not an array"}',
      '{"messages":[]}',
    ]) {
      assert.equal(stripTrailingAssistant(junk), null, junk)
    }
  })
})
