import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  config,
  FALLBACK_CC_VERSION,
  getModelOverride,
} from "./model-config.ts"

describe("getModelOverride", () => {
  it("returns null for a model with no override", () => {
    assert.equal(getModelOverride("definitely-not-a-model"), null)
  })

  it("returns the override for every model the config declares", () => {
    for (const id of Object.keys(config.overrides ?? {})) {
      assert.notEqual(
        getModelOverride(id),
        null,
        `no override resolved for ${id}`,
      )
    }
  })

  it("is not confused by an empty id", () => {
    assert.equal(getModelOverride(""), null)
  })
})

/** "2.1.282" -> [2,1,282], so two versions can be compared as numbers. */
const parts = (v: string) => v.split(".").map(Number)

const atLeast = (have: string, want: string) => {
  const [a, b, c] = parts(have)
  const [x, y, z] = parts(want)
  return a! > x! || (a === x && (b! > y! || (b === y && c! >= z!)))
}

describe("the reported Claude Code version", () => {
  it("is a version, not a placeholder", () => {
    assert.match(config.ccVersion, /^\d+\.\d+\.\d+$/)
  })

  it("is at least the fallback, never behind it", () => {
    // A detected version older than the constant would mean an ancient CLI on
    // PATH silently re-introducing the gate this exists to avoid.
    assert.equal(
      atLeast(config.ccVersion, FALLBACK_CC_VERSION),
      true,
      `reporting ${config.ccVersion}, older than the ${FALLBACK_CC_VERSION} fallback`,
    )
  })

  it("keeps the fallback current enough to matter", () => {
    // Opus 5.5 requires 2.1.280. A fallback below any shipped gate is a
    // fallback that blocks a model on every machine without the CLI.
    assert.equal(
      atLeast(FALLBACK_CC_VERSION, "2.1.280"),
      true,
      "the fallback predates a known model gate",
    )
  })
})
