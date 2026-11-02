import assert from "node:assert/strict"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { withFileLock } from "./file-lock.ts"
import { readIdentityCache } from "./identity.ts"

describe("withFileLock", () => {
  it("runs the work and removes its lock", () => {
    const p = join(mkdtempSync(join(tmpdir(), "fl-")), "f.json")
    assert.equal(
      withFileLock(p, () => 7),
      7,
    )
    assert.equal(existsSync(`${p}.lock`), false)
  })

  it("takes over a lock whose owner is gone", () => {
    const p = join(mkdtempSync(join(tmpdir(), "fl-")), "f.json")
    writeFileSync(
      `${p}.lock`,
      JSON.stringify({ pid: 999_999_999, at: Date.now() }),
    )
    const t0 = Date.now()
    withFileLock(p, () => undefined, 2_000)
    assert.ok(Date.now() - t0 < 1_000)
    assert.equal(existsSync(`${p}.lock`), false)
  })

  it("gives up waiting on a live holder and runs anyway", () => {
    const p = join(mkdtempSync(join(tmpdir(), "fl-")), "f.json")
    writeFileSync(
      `${p}.lock`,
      JSON.stringify({ pid: process.ppid, at: Date.now() }),
    )
    let ran = false
    withFileLock(p, () => (ran = true), 50)
    assert.equal(ran, true)
    assert.equal(
      existsSync(`${p}.lock`),
      true,
      "someone else's lock is left alone",
    )
  })

  // Regression: two processes read-modify-writing the identity cache dropped
  // each other's entries (atomic rename prevents tearing, not lost updates).
  it("keeps every entry when two processes write the identity cache at once", () => {
    const p = join(mkdtempSync(join(tmpdir(), "fl-")), "ids.json")
    const script = (tag: string) =>
      `import("./src/balance/identity.ts").then((m) => { for (let i = 0; i < 40; i++) m.writeIdentity("${tag}" + i, { accountUuid: "u", orgUuid: "o" }, 1, ${JSON.stringify(p)}) })`
    return Promise.resolve().then(async () => {
      const { spawn } = await import("node:child_process")
      const go = (tag: string) =>
        new Promise<void>((resolve, reject) => {
          const c = spawn(
            process.execPath,
            ["--experimental-strip-types", "-e", script(tag)],
            {
              cwd: process.cwd(),
              stdio: "ignore",
            },
          )
          c.on("exit", (code) =>
            code === 0 ? resolve() : reject(new Error(`exit ${code}`)),
          )
        })
      await Promise.all([go("a"), go("b")])
      assert.equal(Object.keys(readIdentityCache(p)).length, 80)
    })
  })
})
