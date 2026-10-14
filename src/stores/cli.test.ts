import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { StoreSpec } from "../config.ts"
import {
  describeExpiry,
  importBlob,
  pickRamDir,
  runCli,
  type CliIO,
} from "./cli.ts"
import type { Exec } from "./helper.ts"

const NOW = 1_000_000_000_000
const blob = (expiresAt: number) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: "SECRET-A",
      refreshToken: "SECRET-R",
      expiresAt,
      scopes: ["user:inference"],
    },
  })

function broker(initial: Record<string, string> = {}) {
  const kv = { ...initial }
  const exec: Exec = (_f, args, opts) => {
    const [op, id] = args.slice(-2)
    if (op === "get" && id && id in kv) return kv[id] ?? ""
    if (op === "store" && id) {
      kv[id] = opts.input ?? ""
      return ""
    }
    throw new Error("exit 1")
  }
  return { kv, exec }
}

function io(
  over: Partial<CliIO> = {},
): CliIO & { lines: string[]; errs: string[] } {
  const lines: string[] = []
  const errs: string[] = []
  return {
    lines,
    errs,
    out: (l) => lines.push(l),
    err: (l) => errs.push(l),
    stdin: () => "",
    runClaude: () => 0,
    ramDir: () => tmpdir(),
    now: () => NOW,
    ...over,
  }
}

const helperSpec = (id: string): StoreSpec => ({
  id,
  backend: "helper",
  command: ["broker"],
})

describe("check", () => {
  it("reports each store without printing tokens; exit 2 when one is missing", () => {
    const { exec } = broker({ t1: blob(NOW + 3 * 3_600_000) })
    const o = io({ exec })
    assert.equal(runCli(["check"], [helperSpec("t1"), helperSpec("t2")], o), 2)
    assert.deepEqual(o.lines, [
      "t1\thelper\texpires in 3h",
      "t2\thelper\tMISSING",
    ])
    assert.ok(!o.lines.join().includes("SECRET"))
  })
  it("fails when nothing is declared", () => {
    assert.equal(runCli(["check"], [], io()), 1)
  })
})

describe("import", () => {
  it("stores the raw blob from stdin unchanged (scopes kept)", () => {
    const { kv, exec } = broker()
    const o = io({ exec, stdin: () => blob(NOW + 600_000) })
    assert.equal(runCli(["import", "t1"], [helperSpec("t1")], o), 0)
    assert.equal(kv.t1, blob(NOW + 600_000))
    assert.equal(o.lines[0], "t1: stored (expires in 10m)")
  })
  it("reads <dir>/.credentials.json with --from", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-from-"))
    writeFileSync(join(dir, ".credentials.json"), blob(NOW + 600_000))
    const { kv, exec } = broker()
    assert.equal(
      runCli(["import", "t1", "--from", dir], [helperSpec("t1")], io({ exec })),
      0,
    )
    assert.ok(kv.t1)
  })
  it("refuses garbage and unknown stores", () => {
    const { exec } = broker()
    assert.equal(
      runCli(
        ["import", "t1"],
        [helperSpec("t1")],
        io({ exec, stdin: () => "nope" }),
      ),
      1,
    )
    assert.equal(runCli(["import", "zz"], [helperSpec("t1")], io({ exec })), 1)
  })
})

describe("login", () => {
  it("logs in inside a throwaway dir, stores the result, and deletes the dir", () => {
    const { kv, exec } = broker()
    let used = ""
    const o = io({
      exec,
      runClaude: (dir) => {
        used = dir
        writeFileSync(join(dir, ".credentials.json"), blob(NOW + 600_000))
        return 0
      },
    })
    assert.equal(runCli(["login", "t1"], [helperSpec("t1")], o), 0)
    assert.ok(kv.t1)
    assert.ok(used && !existsSync(used), "login dir must be gone")
  })
  it("fails cleanly when no login was saved", () => {
    const o = io({ runClaude: () => 1 })
    assert.equal(runCli(["login", "t1"], [helperSpec("t1")], o), 1)
  })
})

describe("importBlob", () => {
  it("writes a file store's credentials file 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-file-"))
    assert.equal(
      importBlob({ id: "f", backend: "file", configDir: dir }, blob(NOW)),
      true,
    )
    assert.equal(
      JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf-8"))
        .claudeAiOauth.accessToken,
      "SECRET-A",
    )
  })
  it("does not write Keychain stores", () => {
    assert.equal(
      importBlob({ id: "k", backend: "keychain", service: "s" }, blob(NOW)),
      false,
    )
  })
})

describe("helpers", () => {
  it("describeExpiry", () => {
    assert.equal(
      describeExpiry(NOW - 1, NOW),
      "expired (refreshable if a refresh token is held)",
    )
    assert.equal(describeExpiry(NOW + 30 * 60_000, NOW), "expires in 30m")
  })
  it("pickRamDir prefers /dev/shm over disk tmp", () => {
    assert.equal(
      pickRamDir((p) => p === "/dev/shm"),
      "/dev/shm",
    )
  })
})
