import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  indentJson,
  isEditable,
  presetRows,
  togglePresetAccount,
  validatePresetName,
  type PresetMap,
} from "./presets.ts"

const PRESETS: PresetMap = {
  "rr-12": {
    label: "LB round-robin Team 1,2",
    strategy: "round-robin",
    accounts: ["s1", "s2"],
  },
  tiered: {
    label: "Team 1+2, fall back to 3",
    pools: [{ name: "primary" }, { name: "reserve" }],
  },
}

describe("isEditable", () => {
  it("refuses a pool-based preset", () => {
    // Tiered failover is a list of groups each with its own strategy. Editing
    // that in a one-line dialog is a worse text editor than the open one.
    assert.equal(isEditable(PRESETS["rr-12"]!), true)
    assert.equal(isEditable(PRESETS.tiered!), false)
  })
})

describe("togglePresetAccount", () => {
  it("adds an account not in the set", () => {
    const out = togglePresetAccount(PRESETS["rr-12"]!, "s3")!
    assert.deepEqual(out.accounts, ["s1", "s2", "s3"])
  })

  it("removes one that is", () => {
    const out = togglePresetAccount(PRESETS["rr-12"]!, "s1")!
    assert.deepEqual(out.accounts, ["s2"])
  })

  it("refuses to empty the set", () => {
    // A preset matching nothing is fallen through silently rather than
    // reported, so it reads as a balancer bug rather than an empty preset.
    assert.equal(togglePresetAccount({ accounts: ["s1"] }, "s1"), null)
  })

  it("leaves the label and strategy alone", () => {
    const out = togglePresetAccount(PRESETS["rr-12"]!, "s3")!
    assert.equal(out.label, "LB round-robin Team 1,2")
    assert.equal(out.strategy, "round-robin")
  })
})

describe("validatePresetName", () => {
  it("accepts a plain name", () => {
    assert.deepEqual(validatePresetName(" rr-99 ", PRESETS), {
      ok: true,
      name: "rr-99",
    })
  })

  it("refuses an empty one", () => {
    assert.equal(validatePresetName("   ", PRESETS).ok, false)
  })

  it("refuses a name already taken", () => {
    const out = validatePresetName("rr-12", PRESETS)
    assert.equal(out.ok, false)
    assert.match(out.ok === false ? out.reason : "", /already/)
  })

  it("refuses characters that would need quoting as a config key", () => {
    for (const bad of ["a b", 'a"b', "a/b", "a:b"]) {
      assert.equal(validatePresetName(bad, PRESETS).ok, false, bad)
    }
  })
})

describe("indentJson", () => {
  it("indents every line after the first, so the block sits in the file", () => {
    const out = indentJson({ a: { b: 1 } }, 2)
    const lines = out.split("\n")
    assert.equal(lines[0], "{")
    assert.ok(lines[1]!.startsWith('    "a"'), lines[1])
    assert.equal(lines[lines.length - 1], "  }")
  })

  it("round-trips through JSON.parse", () => {
    assert.deepEqual(JSON.parse(indentJson(PRESETS, 2)), PRESETS)
  })
})

describe("presetRows", () => {
  it("describes what each preset does, not just its name", () => {
    const rows = presetRows(PRESETS, "__auto__")
    assert.match(rows[0]!.description, /round-robin over 2 accounts/)
  })

  it("marks the one in use", () => {
    const rows = presetRows(PRESETS, "preset:rr-12")
    assert.match(rows[0]!.description, /in use/)
    assert.ok(!rows[1]!.description.includes("in use"))
  })

  it("says which presets it will not edit, rather than hiding them", () => {
    const rows = presetRows(PRESETS, "__auto__")
    assert.match(rows[1]!.description, /read only/)
  })
})
