import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readFileSync } from "node:fs"

import { VERSION } from "./version.ts"

describe("VERSION", () => {
  it("is the version package.json declares, not a copy of it", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string }
    assert.equal(VERSION, pkg.version)
  })

  it("looks like a version", () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+/)
  })
})
