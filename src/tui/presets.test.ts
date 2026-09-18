import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  indentJson,
  isEditable,
  knobRows,
  moveRef,
  orderRows,
  presetMembership,
  PRESET_KNOBS,
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

/** Stands in for the TUI's value formatter. */
const render = (_k: string, v: unknown) => String(v)

describe("knobRows", () => {
  const defaults = {
    strategy: "sticky",
    autoSwitch: true,
    switchAt: 0.95,
    switchWindow: "binding",
    ejectFor: 300_000,
    weights: {},
  }

  it("marks what the preset set apart from what it inherited", () => {
    // "Switch at: 0.95" alone cannot distinguish a deliberate 0.95 from an
    // inherited one, and the two diverge the moment the default changes.
    const rows = knobRows({ accounts: ["a"], switchAt: 0.8 }, defaults, render)
    const at = rows.find((r) => r.value === "k:switchAt")!
    assert.match(at.title, /0\.8/)
    assert.equal(at.description, "set by this preset")
    assert.equal(
      rows.find((r) => r.value === "k:switchWindow")!.description,
      "inherited from the defaults",
    )
  })

  it("shows the inherited value, not a blank", () => {
    const rows = knobRows({ accounts: ["a"] }, defaults, render)
    assert.match(rows.find((r) => r.value === "k:switchAt")!.title, /0\.95/)
  })

  it("offers weights only when the strategy actually reads them", () => {
    // A ratio beside a strategy that ignores it is a control that appears to do
    // something and does not.
    const plain = knobRows({ accounts: ["a"] }, defaults, render)
    assert.ok(!plain.some((r) => r.value === "k:weights"))
    const weighted = knobRows(
      { accounts: ["a"], strategy: "weighted" },
      defaults,
      render,
    )
    assert.ok(weighted.some((r) => r.value === "k:weights"))
  })

  it("sees a strategy inherited from the defaults too", () => {
    const rows = knobRows(
      { accounts: ["a"] },
      { ...defaults, strategy: "weighted" },
      render,
    )
    assert.ok(rows.some((r) => r.value === "k:weights"))
  })

  it("shows only the knobs the strategy in force reads", () => {
    // `weights` and `order` each belong to exactly one strategy, so the row
    // count varies by strategy rather than always being every knob.
    const weighted = knobRows(
      { accounts: ["a"], strategy: "weighted" },
      defaults,
      render,
    )
    assert.ok(weighted.some((r) => r.value === "k:weights"))
    assert.ok(!weighted.some((r) => r.value === "k:order"))

    const prioritised = knobRows(
      { accounts: ["a"], strategy: "priority" },
      defaults,
      render,
    )
    assert.ok(prioritised.some((r) => r.value === "k:order"))
    assert.ok(!prioritised.some((r) => r.value === "k:weights"))

    const plain = knobRows({ accounts: ["a"] }, defaults, render)
    assert.equal(plain.length, PRESET_KNOBS.length - 2)
  })
})

describe("moveRef", () => {
  const list = ["a", "b", "c"]

  it("moves one entry up and down", () => {
    assert.deepEqual(moveRef(list, "b", "up"), ["b", "a", "c"])
    assert.deepEqual(moveRef(list, "b", "down"), ["a", "c", "b"])
  })

  it("moves to either end", () => {
    assert.deepEqual(moveRef(list, "c", "top"), ["c", "a", "b"])
    assert.deepEqual(moveRef(list, "a", "bottom"), ["b", "c", "a"])
  })

  it("answers null when the move would change nothing", () => {
    // A write that changes nothing still moves the file's timestamp, and the
    // timestamp is what every reader watches.
    assert.equal(moveRef(list, "a", "up"), null)
    assert.equal(moveRef(list, "c", "down"), null)
    assert.equal(moveRef(list, "a", "top"), null)
    assert.equal(moveRef(list, "c", "bottom"), null)
  })

  it("answers null for an entry that is not there", () => {
    assert.equal(moveRef(list, "zz", "up"), null)
  })

  it("does not mutate the list it was given", () => {
    const original = [...list]
    moveRef(list, "b", "up")
    assert.deepEqual(list, original)
  })

  it("keeps the reference spelling, not the resolved source", () => {
    // A preset's accounts are references; rewriting them as sources on a
    // reorder would quietly rewrite config the user hand-wrote.
    const refs = ["Acme 1", "Acme 2"]
    assert.deepEqual(moveRef(refs, "Acme 2", "up"), ["Acme 2", "Acme 1"])
  })
})

/** Two references, resolved the way the balancer would. */
const resolveOrderRef = (ref: string) => (ref === "Acme 1" ? "s1" : "s2")

describe("orderRows", () => {
  const names = new Map([
    ["s1", "Team 1"],
    ["s2", "Team 2"],
  ])

  it("numbers the positions, since position is the whole meaning", () => {
    const rows = orderRows(["Acme 1", "Acme 2"], names, resolveOrderRef)
    assert.match(rows[0]!.title, /^1\. Team 1/)
    assert.match(rows[1]!.title, /^2\. Team 2/)
  })

  it("says what first means, and what the others wait for", () => {
    const rows = orderRows(["Acme 1", "Acme 2"], names, resolveOrderRef)
    assert.match(rows[0]!.description, /first/)
    assert.match(rows[1]!.description, /after 1 other$/)
  })

  it("falls back to the reference when it resolves to nothing", () => {
    const rows = orderRows(["ghost"], names, () => undefined)
    assert.match(rows[0]!.title, /ghost/)
  })
})
