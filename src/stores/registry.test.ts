import { afterEach, describe, it } from "node:test"
import assert from "node:assert/strict"

import type { ClaudeCredentials } from "../keychain.ts"
import {
  authJsonMirrorEnabled,
  clearStores,
  declaredAccounts,
  registerStore,
  setAuthJsonMirror,
  setDeclaredStores,
  storeFor,
  type CredentialStore,
} from "./registry.ts"

const creds = (t: string): ClaudeCredentials => ({
  accessToken: t,
  refreshToken: `r-${t}`,
  expiresAt: 1,
})
const store = (
  source: string,
  kind: CredentialStore["kind"],
  c: ClaudeCredentials | null,
): CredentialStore => ({
  source,
  kind,
  label: `L-${source}`,
  read: () => c,
  write: () => true,
})

afterEach(() => clearStores())

describe("storeFor", () => {
  it("returns registered file and helper stores", () => {
    registerStore(store("a", "file", null))
    registerStore(store("b", "helper", null))
    assert.equal(storeFor("a")?.kind, "file")
    assert.equal(storeFor("b")?.kind, "helper")
  })
  it("leaves Keychain stores to upstream's native path", () => {
    registerStore(store("Claude Code-credentials", "keychain", null))
    assert.equal(storeFor("Claude Code-credentials"), undefined)
  })
  it("is undefined for an unknown source", () => {
    assert.equal(storeFor("nope"), undefined)
  })
})

describe("declaredAccounts", () => {
  it("is null when nothing is declared, so discovery runs", () => {
    assert.equal(declaredAccounts(), null)
    setDeclaredStores([])
    assert.equal(declaredAccounts(), null)
  })
  it("lists declared stores in order, skipping those with no credentials", () => {
    setDeclaredStores([
      store("t2", "helper", creds("2")),
      store("t1", "helper", null),
      store("t3", "file", creds("3")),
    ])
    const got = declaredAccounts()
    assert.deepEqual(
      got?.map((a) => a.source),
      ["t2", "t3"],
    )
    assert.equal(got?.[0]?.label, "L-t2")
    assert.equal(got?.[1]?.credentials.accessToken, "3")
  })
  it("declares even Keychain stores (they are listed, not routed)", () => {
    setDeclaredStores([store("svc", "keychain", creds("k"))])
    assert.deepEqual(
      declaredAccounts()?.map((a) => a.source),
      ["svc"],
    )
    assert.equal(storeFor("svc"), undefined)
  })
})

describe("auth.json mirror", () => {
  it("defaults on and can be turned off", () => {
    assert.equal(authJsonMirrorEnabled(), true)
    setAuthJsonMirror(false)
    assert.equal(authJsonMirrorEnabled(), false)
    clearStores()
    assert.equal(authJsonMirrorEnabled(), true)
  })
})
