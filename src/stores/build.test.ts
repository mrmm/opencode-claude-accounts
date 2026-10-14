import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildStore, freshBlob } from "./build.ts"
import type { Exec } from "./helper.ts"

const blob = (access: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: access,
      refreshToken: "r",
      expiresAt: 5,
      scopes: ["user:inference"],
      ...extra,
    },
  })

/** In-memory helper that behaves like a secret broker. */
function fakeHelper(initial: Record<string, string> = {}) {
  const kv = { ...initial }
  const exec: Exec = (_file, args, opts) => {
    const [op, id] = args.slice(-2)
    if (args.at(-1) === "list") return Object.keys(kv).join("\n")
    if (op === "get") {
      if (!id || !(id in kv)) throw new Error("exit 1")
      return kv[id] ?? ""
    }
    if (op === "store" && id) {
      kv[id] = opts.input ?? ""
      return ""
    }
    throw new Error("bad op")
  }
  return { kv, exec }
}

describe("helper store", () => {
  it("reads credentials through the helper", () => {
    const { exec } = fakeHelper({ t1: blob("A") })
    const s = buildStore(
      { id: "t1", backend: "helper", name: "Team 1", command: ["h"] },
      exec,
    )
    assert.equal(s.source, "t1")
    assert.equal(s.label, "Team 1")
    assert.equal(s.read()?.accessToken, "A")
  })
  it("reads null when the helper has nothing", () => {
    const { exec } = fakeHelper()
    assert.equal(
      buildStore({ id: "t1", backend: "helper", command: ["h"] }, exec).read(),
      null,
    )
  })
  it("writes back in place, keeping fields the plugin does not model", () => {
    const { kv, exec } = fakeHelper({ t1: blob("OLD") })
    const s = buildStore({ id: "t1", backend: "helper", command: ["h"] }, exec)
    assert.equal(
      s.write({ accessToken: "NEW", refreshToken: "R2", expiresAt: 9 }),
      true,
    )
    const stored = JSON.parse(kv.t1 ?? "{}").claudeAiOauth
    assert.equal(stored.accessToken, "NEW")
    assert.equal(stored.refreshToken, "R2")
    assert.deepEqual(stored.scopes, ["user:inference"])
  })
  it("writes a fresh Claude Code blob when the helper held nothing", () => {
    const { kv, exec } = fakeHelper()
    const s = buildStore({ id: "t9", backend: "helper", command: ["h"] }, exec)
    assert.equal(
      s.write({ accessToken: "N", refreshToken: "R", expiresAt: 1 }),
      true,
    )
    assert.equal(
      kv.t9,
      freshBlob({ accessToken: "N", refreshToken: "R", expiresAt: 1 }),
    )
  })
  it("reports a refused store as a failed write", () => {
    const exec: Exec = () => {
      throw new Error("exit 1")
    }
    assert.equal(
      buildStore({ id: "t", backend: "helper", command: ["h"] }, exec).write({
        accessToken: "a",
        refreshToken: "b",
        expiresAt: 1,
      }),
      false,
    )
  })
})

describe("file store", () => {
  it("reads and writes <configDir>/.credentials.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "stores-file-"))
    writeFileSync(join(dir, ".credentials.json"), blob("F"))
    const s = buildStore({ id: "t1", backend: "file", configDir: dir })
    assert.equal(s.configDir, dir)
    assert.equal(s.read()?.accessToken, "F")
    assert.equal(
      s.write({ accessToken: "G", refreshToken: "R", expiresAt: 7 }),
      true,
    )
    assert.equal(
      JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf-8"))
        .claudeAiOauth.accessToken,
      "G",
    )
  })
})

describe("keychain store", () => {
  it("is keyed by the service name and marked keychain", () => {
    const s = buildStore({
      id: "work",
      backend: "keychain",
      service: "Claude Code-credentials-abcd1234",
    })
    assert.equal(s.source, "Claude Code-credentials-abcd1234")
    assert.equal(s.kind, "keychain")
    assert.equal(s.label, "work")
  })
})
