import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { resolveContextEditing } from "./balance/index.ts"
import { DEFAULT_CONFIG } from "./config.ts"
import { prepareBody } from "./request-body.ts"

const settings = resolveContextEditing({
  ...DEFAULT_CONFIG,
  contextEditing: true,
})

const raw = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    model: "claude-opus-4-8",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
        ],
      },
    ],
    tools: [{ name: "read", input_schema: { type: "object" } }],
    ...extra,
  })

describe("prepareBody", () => {
  it("applies the shape, ttl and context editing from one parse", () => {
    const r = raw()
    let parses = 0
    const realParse = JSON.parse
    JSON.parse = ((...a: Parameters<typeof JSON.parse>) => {
      parses++
      return realParse(...a)
    }) as typeof JSON.parse
    let out
    try {
      out = prepareBody(r, realParse(r), {
        ttl: "1h",
        contextEditing: settings,
      })
    } finally {
      JSON.parse = realParse
    }
    assert.equal(parses, 0, "prepareBody parses nothing itself")
    const sent = JSON.parse(String(out.body))
    assert.ok(sent.context_management)
    assert.equal(sent.messages[0].content.at(-1).cache_control.ttl, "1h")
    assert.match(sent.system[0].text, /x-anthropic-billing-header/)
    assert.equal(out.contextEdited, true)
    assert.equal(out.ttlSet, true)
    const retry = JSON.parse(String(out.withoutEditing()))
    assert.equal(retry.context_management, undefined)
    assert.equal(retry.messages[0].content.at(-1).cache_control.ttl, "1h")
  })

  // Regression: telemetry logged a 1h write whenever 1h was resolved, even
  // when the body had no marker to carry it.
  it("reports no ttl when the body has no cache_control marker", () => {
    const r = JSON.stringify({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
    })
    const out = prepareBody(r, JSON.parse(r), { ttl: "1h" })
    assert.equal(out.ttlSet, false)
  })

  it("leaves a non-JSON or non-string body alone", () => {
    assert.equal(prepareBody("not json", undefined, {}).body, "not json")
    const blob = new Blob(["x"])
    assert.equal(prepareBody(blob, undefined, {}).body, blob)
  })
})
