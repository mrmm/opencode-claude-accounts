import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { spentBanner } from "./spent.ts"

describe("spentBanner", () => {
  const clock = () => "20:49"
  it("is hidden while anything can serve", () => {
    assert.equal(spentBanner({ anyUsable: true, nowMs: 0, clock }), undefined)
  })
  it("names the next account back and the wait", () => {
    assert.equal(
      spentBanner({
        anyUsable: false,
        next: { name: "Alt 2", at: 3_720_000 },
        nowMs: 0,
        clock,
      }),
      "all spent · next back Alt 2 at 20:49 (in 1h02m)",
    )
  })
  it("says so when no reset is known", () => {
    assert.equal(
      spentBanner({ anyUsable: false, nowMs: 0, clock }),
      "all spent · no reset time known",
    )
  })
})
