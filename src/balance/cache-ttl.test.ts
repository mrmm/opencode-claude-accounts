import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  AUTO_AGE_MS,
  AUTO_GAP_MS,
  applyCacheTtl,
  resolveTtl,
} from "./cache-ttl.ts"

describe("resolveTtl", () => {
  it("5m leaves the body untouched", () => {
    assert.equal(resolveTtl("5m", { nowMs: 0 }), "leave")
  })
  it("1h always sets 1h", () => {
    assert.equal(resolveTtl("1h", { nowMs: 0 }), "1h")
  })
  it("auto lifts to 1h after a long idle gap", () => {
    assert.equal(
      resolveTtl("auto", {
        nowMs: 100_000,
        prevRequestAt: 100_000 - AUTO_GAP_MS - 1,
      }),
      "1h",
    )
  })
  it("auto leaves a busy session at 5m", () => {
    assert.equal(
      resolveTtl("auto", { nowMs: 100_000, prevRequestAt: 100_000 - 1000 }),
      "leave",
    )
  })
  it("auto lifts to 1h for a long-running session", () => {
    assert.equal(
      resolveTtl("auto", { nowMs: AUTO_AGE_MS + 2, sessionStartedAt: 1 }),
      "1h",
    )
  })
  it("auto with no timing leaves it alone", () => {
    assert.equal(resolveTtl("auto", { nowMs: 100_000 }), "leave")
  })
})

describe("applyCacheTtl", () => {
  const body = () =>
    JSON.stringify({
      tools: [{ name: "x", cache_control: { type: "ephemeral" } }],
      system: [
        { type: "text", text: "s", cache_control: { type: "ephemeral" } },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    })

  it("sets ttl on every marker when lifting to 1h", () => {
    const out = JSON.parse(applyCacheTtl(body(), "1h"))
    assert.equal(out.tools[0].cache_control.ttl, "1h")
    assert.equal(out.system[0].cache_control.ttl, "1h")
    assert.equal(out.messages[0].content[0].cache_control.ttl, "1h")
  })

  it("leaves the body identical on 'leave'", () => {
    const b = body()
    assert.equal(applyCacheTtl(b, "leave"), b)
  })

  it("is a no-op when there are no markers", () => {
    const b = JSON.stringify({ messages: [{ role: "user", content: "hi" }] })
    assert.equal(applyCacheTtl(b, "1h"), b)
  })

  it("returns an unparseable body unchanged", () => {
    assert.equal(applyCacheTtl("not json", "1h"), "not json")
  })

  it("preserves a string system prompt", () => {
    const b = JSON.stringify({ system: "plain", messages: [] })
    assert.equal(applyCacheTtl(b, "1h"), b)
  })
})
