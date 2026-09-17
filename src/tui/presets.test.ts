import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  indentJson,
  isEditable,
  presetMembership,
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

const MEMBERS = [
  { source: "s1", label: "Claude Team - Acme 1 - Wings" },
  { source: "s2", label: "Claude Team - Acme 2 - Survey" },
  { source: "s3", label: "Claude Team - Acme 3 - Scouting" },
]

describe("presetMembership", () => {
  it("resolves label fragments, which is how a hand-written config reads", () => {
    // The bug: membership was tested against Keychain sources, so a preset
    // written as ["Acme 1","Acme 2"] rendered with nothing ticked at all.
    const m = presetMembership({ accounts: ["Acme 1", "Acme 2"] }, MEMBERS)
    assert.deepEqual([...m.sources].sort(), ["s1", "s2"])
  })

  it("resolves exact sources too", () => {
    const m = presetMembership({ accounts: ["s3"] }, MEMBERS)
    assert.deepEqual([...m.sources], ["s3"])
  })

  it("remembers which spelling resolved to which account", () => {
    const m = presetMembership({ accounts: ["Acme 1"] }, MEMBERS)
    assert.equal(m.refFor.get("s1"), "Acme 1")
  })

  it("reports references that go nowhere instead of dropping them", () => {
    // A reference matching nothing -- or matching two, which resolveRef
    // refuses -- makes the preset quietly smaller than it reads.
    const m = presetMembership(
      { accounts: ["Acme 1", "gone", "Acme"] },
      MEMBERS,
    )
    assert.deepEqual([...m.sources], ["s1"])
    assert.deepEqual(m.unresolved, ["gone", "Acme"])
  })
})

describe("togglePresetAccount", () => {
  it("adds an account not in the set, as an exact source", () => {
    const out = togglePresetAccount({ accounts: ["Acme 1"] }, "s3", MEMBERS)!
    assert.deepEqual(out.accounts, ["Acme 1", "s3"])
  })

  it("removes by the spelling that resolved to it", () => {
    // The hand-written fragments of the others have to survive the edit.
    const out = togglePresetAccount(
      { accounts: ["Acme 1", "Acme 2"] },
      "s1",
      MEMBERS,
    )!
    assert.deepEqual(out.accounts, ["Acme 2"])
  })

  it("refuses to empty the set", () => {
    assert.equal(
      togglePresetAccount({ accounts: ["Acme 1"] }, "s1", MEMBERS),
      null,
    )
  })

  it("counts resolved membership, not the raw list, before refusing", () => {
    // Two references, one of which resolves nowhere: removing the only real
    // one still empties the preset.
    assert.equal(
      togglePresetAccount({ accounts: ["Acme 1", "gone"] }, "s1", MEMBERS),
      null,
    )
  })

  it("leaves the label and strategy alone", () => {
    const out = togglePresetAccount(PRESETS["rr-12"]!, "s3", MEMBERS)!
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
