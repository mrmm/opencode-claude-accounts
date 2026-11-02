import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { accountKey } from "./account-key.ts"

describe("accountKey", () => {
  it("is identity over the source string for now", () => {
    assert.equal(accountKey("work"), "work")
    assert.equal(accountKey("~/.claude-alt"), "~/.claude-alt")
  })
})
