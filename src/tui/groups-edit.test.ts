import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  createGroup,
  deleteGroup,
  groupIdFor,
  presetsUsingGroup,
  renameGroup,
  toggleGroupMember,
} from "./groups-edit.ts"

describe("group editing", () => {
  it("derives a stable, unique id from the name", () => {
    assert.equal(groupIdFor("Team leads", {}), "team-leads")
    assert.equal(
      groupIdFor("Team leads", { "team-leads": { accounts: [] } }),
      "team-leads-2",
    )
    assert.equal(groupIdFor("!!", {}), "group")
  })

  it("renaming changes the label only, so references survive", () => {
    const made = createGroup({}, "Main")
    assert.ok("id" in made)
    const renamed = renameGroup(made.groups, made.id, "Primary")
    assert.ok(!("error" in renamed))
    assert.deepEqual(Object.keys(renamed.groups), ["main"])
    assert.equal(renamed.groups.main!.label, "Primary")
  })

  it("refuses a duplicate or empty name", () => {
    const g = { main: { accounts: [], label: "Main" } }
    assert.ok("error" in createGroup(g, "Main"))
    assert.ok("error" in createGroup(g, "  "))
    assert.ok(
      "error" in renameGroup({ ...g, alt: { accounts: [] } }, "alt", "Main"),
    )
  })

  it("toggles a member by resolving any spelling, and writes the id", () => {
    const resolve = (r: string) => ({ "acme-1": "s1", s2: "s2" })[r]
    const refOf = (s: string) => `acme-${s.slice(1)}`
    let g = { main: { accounts: ["acme-1"] } }
    g = toggleGroupMember(g, "main", "s2", resolve, refOf)
    assert.deepEqual(g.main.accounts, ["acme-1", "acme-2"])
    g = toggleGroupMember(g, "main", "s1", resolve, refOf)
    assert.deepEqual(g.main.accounts, ["acme-2"])
  })

  it("names the presets a delete would affect", () => {
    const presets = {
      a: { accounts: ["main"] },
      b: { pools: [{ accounts: ["x", "main"] }] },
      c: { accounts: ["x"] },
    }
    assert.deepEqual(presetsUsingGroup(presets, "main"), ["a", "b"])
    assert.deepEqual(
      deleteGroup({ main: { accounts: [] }, alt: { accounts: [] } }, "main"),
      {
        alt: { accounts: [] },
      },
    )
  })
})
