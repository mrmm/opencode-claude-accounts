import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { HELPER_TIMEOUT_MS, runHelper, type Exec } from "./helper.ts"

type Call = { file: string; args: string[]; input?: string; timeout: number }

function recorder(result: string | Error): { exec: Exec; calls: Call[] } {
  const calls: Call[] = []
  const exec: Exec = (file, args, opts) => {
    calls.push({ file, args, input: opts.input, timeout: opts.timeout })
    if (result instanceof Error) throw result
    return result
  }
  return { exec, calls }
}

describe("runHelper", () => {
  it("appends op and id after the configured command", () => {
    const { exec, calls } = recorder('{"claudeAiOauth":{}}')
    const out = runHelper(
      ["secret-broker", "claude"],
      "get",
      "team-1",
      undefined,
      exec,
    )
    assert.equal(out, '{"claudeAiOauth":{}}')
    assert.deepEqual(calls[0], {
      file: "secret-broker",
      args: ["claude", "get", "team-1"],
      input: undefined,
      timeout: HELPER_TIMEOUT_MS,
    })
  })
  it("passes the blob on stdin for store", () => {
    const { exec, calls } = recorder("")
    assert.equal(runHelper(["h"], "store", "x", "BLOB", exec), "")
    assert.equal(calls[0]?.input, "BLOB")
    assert.deepEqual(calls[0]?.args, ["store", "x"])
  })
  it("omits the id for list", () => {
    const { exec, calls } = recorder("a\nb\n")
    runHelper(["h"], "list", undefined, undefined, exec)
    assert.deepEqual(calls[0]?.args, ["list"])
  })
  it("returns null on non-zero exit, timeout or missing binary", () => {
    const { exec } = recorder(new Error("exit 1"))
    assert.equal(runHelper(["h"], "get", "x", undefined, exec), null)
  })
  it("returns null for an empty command", () => {
    const { exec, calls } = recorder("x")
    assert.equal(runHelper([], "get", "x", undefined, exec), null)
    assert.equal(calls.length, 0)
  })
})
