import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  applyContextEditing,
  resolveContextEditing,
  contextEditDisabledBy400,
  clearedInputTokens,
  DEFAULT_CONTEXT_EDITING,
} from "./context-edit.ts"
import { DEFAULT_CONFIG, type ClaudeAuthConfig } from "../config.ts"

function cfg(
  contextEditing: ClaudeAuthConfig["contextEditing"],
): ClaudeAuthConfig {
  return { ...DEFAULT_CONFIG, contextEditing }
}

const withTools = { model: "claude", tools: [{ name: "read" }], messages: [] }

describe("resolveContextEditing", () => {
  it("is null when off (the default)", () => {
    assert.equal(resolveContextEditing(cfg(false)), null)
  })

  it("fills every default when true", () => {
    assert.deepEqual(resolveContextEditing(cfg(true)), DEFAULT_CONTEXT_EDITING)
  })

  it("overrides only the knobs given", () => {
    const s = resolveContextEditing(cfg({ trigger: 120000, keep: 4 }))
    assert.deepEqual(s, {
      trigger: 120000,
      keep: 4,
      clearAtLeast: DEFAULT_CONTEXT_EDITING.clearAtLeast,
    })
  })

  it("carries excludeTools through", () => {
    const s = resolveContextEditing(cfg({ excludeTools: ["bash"] }))
    assert.deepEqual(s?.excludeTools, ["bash"])
  })
})

describe("applyContextEditing", () => {
  it("leaves the body unchanged when disabled", () => {
    const r = applyContextEditing(withTools, null)
    assert.equal(r.changed, false)
    assert.equal(r.body, withTools)
  })

  it("adds context_management with defaults when on", () => {
    const r = applyContextEditing(withTools, DEFAULT_CONTEXT_EDITING)
    assert.equal(r.changed, true)
    assert.deepEqual(
      (r.body as { context_management: unknown }).context_management,
      {
        edits: [
          {
            type: "clear_tool_uses_20250919",
            trigger: { type: "input_tokens", value: 150000 },
            keep: { type: "tool_uses", value: 6 },
            clear_at_least: { type: "input_tokens", value: 40000 },
          },
        ],
      },
    )
  })

  it("includes exclude_tools when configured", () => {
    const r = applyContextEditing(withTools, {
      ...DEFAULT_CONTEXT_EDITING,
      excludeTools: ["read"],
    })
    const edit = (
      r.body as {
        context_management: { edits: Array<Record<string, unknown>> }
      }
    ).context_management.edits[0]
    assert.deepEqual(edit.exclude_tools, ["read"])
  })

  it("does not override a client-provided context_management", () => {
    const client = { ...withTools, context_management: { edits: [] } }
    const r = applyContextEditing(client, DEFAULT_CONTEXT_EDITING)
    assert.equal(r.changed, false)
    assert.equal(r.body, client)
  })

  it("is a no-op without tools", () => {
    const r = applyContextEditing(
      { model: "claude", messages: [] },
      DEFAULT_CONTEXT_EDITING,
    )
    assert.equal(r.changed, false)
  })

  it("is a no-op on a non-object body", () => {
    assert.equal(
      applyContextEditing("x", DEFAULT_CONTEXT_EDITING).changed,
      false,
    )
    assert.equal(
      applyContextEditing(null, DEFAULT_CONTEXT_EDITING).changed,
      false,
    )
  })
})

describe("contextEditDisabledBy400", () => {
  it("fires on a context_management complaint", () => {
    assert.equal(
      contextEditDisabledBy400(
        '{"error":{"message":"context_management not supported"}}',
      ),
      true,
    )
    assert.equal(
      contextEditDisabledBy400(
        "the context-management-2025-06-27 beta is unavailable",
      ),
      true,
    )
  })

  it("ignores an unrelated 400", () => {
    assert.equal(contextEditDisabledBy400("messages: too long"), false)
  })
})

describe("clearedInputTokens", () => {
  it("sums cleared_input_tokens across applied edits", () => {
    const n = clearedInputTokens({
      context_management: {
        applied_edits: [
          { cleared_input_tokens: 30000 },
          { cleared_input_tokens: 12000 },
        ],
      },
    })
    assert.equal(n, 42000)
  })

  it("is null when nothing was applied", () => {
    assert.equal(clearedInputTokens({ usage: {} }), null)
    assert.equal(
      clearedInputTokens({ context_management: { applied_edits: [] } }),
      null,
    )
    assert.equal(clearedInputTokens("x"), null)
  })
})
