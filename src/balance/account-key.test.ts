import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { AccountId } from "../config.ts"
import { accountKey, readKeysFor, resolveAccountKey } from "./account-key.ts"
import type { IdentityCache } from "./identity.ts"

const identities: IdentityCache = {
  "Claude Code-credentials-aaaa": {
    accountUuid: "acc-1",
    orgUuid: "org-1",
    fetchedAt: 0,
  },
}
const registry: Record<string, AccountId> = {
  "team-1": { match: { account: "acc-1", org: "org-1" } },
}

describe("accountKey (live)", () => {
  it("falls back to the source when nothing is registered", () => {
    assert.equal(accountKey("work"), "work")
    assert.equal(accountKey("~/.claude-alt"), "~/.claude-alt")
  })
})

describe("resolveAccountKey", () => {
  it("maps a registered source to its id", () => {
    assert.equal(
      resolveAccountKey("Claude Code-credentials-aaaa", identities, registry),
      "team-1",
    )
  })
  it("keeps the source when no id matches", () => {
    assert.equal(
      resolveAccountKey("unknown-src", identities, registry),
      "unknown-src",
    )
  })
})

describe("readKeysFor", () => {
  it("returns id then source for a registered account", () => {
    assert.deepEqual(
      readKeysFor("Claude Code-credentials-aaaa", identities, registry),
      ["team-1", "Claude Code-credentials-aaaa"],
    )
  })
  it("returns a single key for an unregistered account", () => {
    assert.deepEqual(readKeysFor("unknown-src", identities, registry), [
      "unknown-src",
    ])
  })
})
