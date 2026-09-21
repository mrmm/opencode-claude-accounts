import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readFileSync } from "node:fs"

import { BUILD, COMMIT, VERSION } from "./version.ts"

describe("build identity", () => {
  it("is the version package.json declares, not a copy of it", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string }
    assert.equal(VERSION, pkg.version)
  })

  it("looks like a version", () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+/)
  })

  it("carries the commit that built dist, when one was stamped", () => {
    let stamped: { commit: string | null; dirty?: boolean } | null = null
    try {
      stamped = JSON.parse(
        readFileSync(
          new URL("../dist/build-info.json", import.meta.url),
          "utf8",
        ),
      ) as { commit: string | null; dirty?: boolean }
    } catch {
      stamped = null
    }
    if (!stamped?.commit) {
      // A source checkout that has never been built is a legitimate state.
      assert.equal(COMMIT, null)
      assert.equal(BUILD, VERSION)
      return
    }
    assert.match(COMMIT!, /^[0-9a-f]{7,}(-dirty)?$/)
    assert.equal(COMMIT!.startsWith(stamped.commit), true)
    assert.equal(BUILD, `${VERSION}+${COMMIT}`)
  })

  it("says so when the build was made over uncommitted edits", () => {
    // The stamp is the only thing that can know this; asserting the shape here
    // keeps the suffix from being quietly dropped.
    if (COMMIT?.endsWith("-dirty")) {
      assert.match(BUILD, /-dirty$/)
    }
  })
})
