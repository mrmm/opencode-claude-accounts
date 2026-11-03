import assert from "node:assert/strict"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { dataFile, legacyDir, migrateLegacyData } from "./paths.ts"

const home = () => {
  const h = mkdtempSync(join(tmpdir(), "paths-"))
  mkdirSync(legacyDir(h), { recursive: true })
  return h
}

describe("data folder", () => {
  it("moves loose files and their generations into the folder", () => {
    const h = home()
    const old = legacyDir(h)
    writeFileSync(join(old, "claude-auth-usage.jsonl"), "u")
    writeFileSync(join(old, "claude-auth-usage.jsonl.1"), "u1")
    writeFileSync(join(old, "claude-account-source.txt"), "__auto__")
    mkdirSync(join(old, "claude-auth-locks"))
    writeFileSync(join(old, "auth.json"), "{}")
    assert.equal(readFileSync(dataFile("usage.jsonl", h), "utf8"), "u")
    assert.equal(readFileSync(`${dataFile("usage.jsonl", h)}.1`, "utf8"), "u1")
    assert.equal(readFileSync(dataFile("selection.txt", h), "utf8"), "__auto__")
    assert.ok(existsSync(dataFile("locks", h)))
    assert.equal(existsSync(join(old, "claude-auth-usage.jsonl")), false)
    assert.ok(existsSync(join(old, "auth.json")), "OpenCode's own files stay")
  })

  it("keeps the folder's copy when both exist", () => {
    const h = home()
    const old = legacyDir(h)
    mkdirSync(join(old, "claude-auth"))
    writeFileSync(join(old, "claude-auth", "quota.json"), "new")
    writeFileSync(join(old, "claude-auth-quota.json"), "old")
    assert.deepEqual(migrateLegacyData(h), [])
    assert.equal(
      readFileSync(join(old, "claude-auth", "quota.json"), "utf8"),
      "new",
    )
  })

  it("creates nothing when there is nothing to move", () => {
    const h = home()
    migrateLegacyData(h)
    assert.equal(existsSync(join(legacyDir(h), "claude-auth")), false)
  })
})
