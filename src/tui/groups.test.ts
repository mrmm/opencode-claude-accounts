import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { QuotaCache } from "../balance/index.ts"
import { groupRows, memberName } from "./groups.ts"

const FUTURE = Math.floor(Date.now() / 1000) + 3600

const reading = (five: number, week: number): QuotaCache[string] =>
  ({
    fiveHour: { utilization: five, resetsAt: FUTURE, status: "allowed" },
    sevenDay: { utilization: week, resetsAt: FUTURE, status: "allowed" },
    observedAt: 0,
  }) as QuotaCache[string]

const ACCOUNTS = ["src-1", "src-2", "src-3", "src-4"].map((source) => ({
  source,
  label: source,
}))
const ids: Record<string, string> = {
  "acme-1": "src-1",
  "acme-2": "src-2",
  "acme-3": "src-3",
}
const resolve = (ref: string) =>
  ids[ref] ?? ACCOUNTS.find((a) => a.source === ref)?.source

describe("groupRows", () => {
  it("is empty when no groups are configured", () => {
    assert.deepEqual(
      groupRows({ groups: {}, accounts: ACCOUNTS, quota: {}, resolve }),
      [],
    )
  })

  it("sections in config order, members in account order, the rest under Other", () => {
    const out = groupRows({
      groups: {
        Main: { accounts: ["acme-2", "acme-1", "ghost"] },
        Alt: { accounts: ["src-3"], label: "Alt team" },
      },
      accounts: ACCOUNTS,
      quota: {
        "src-1": reading(0.2, 0.9),
        "src-2": reading(0.5, 0.7),
        "src-3": reading(1, 0.1),
      },
      requests: { "src-1": 3, "src-2": 1, "src-3": 4, "src-4": 2 },
      resolve,
    })
    assert.deepEqual(
      out.map((g) => [g.key, g.title, g.sources]),
      [
        ["group:Main", "Main", ["src-1", "src-2"]],
        ["group:Alt", "Alt team", ["src-3"]],
        ["group-other", "Other", ["src-4"]],
      ],
    )
    assert.equal(out[0]!.summary, "5h \u2583  35%  wk \u2587  80%")
    assert.equal(out[0]!.count, "2/2")
    assert.equal(out[0]!.share, "40% reqs")
    assert.equal(
      out[1]!.count,
      "0/1",
      "a spent 5h window makes the account unusable",
    )
    assert.equal(out[0]!.health, "warn", "worst member: week at 90%")
    assert.equal(out[1]!.health, "critical", "spent 5h window")
    assert.equal(out[2]!.health, "unknown")
    assert.equal(
      out[2]!.summary,
      "5h \u2588 100%  wk \u2588 100%",
      "no reading counts as no room",
    )
  })

  it("omits Other when every account is grouped, and the share when nothing was served", () => {
    const out = groupRows({
      groups: { All: { accounts: ["src-1", "src-2", "src-3", "src-4"] } },
      accounts: ACCOUNTS,
      quota: {},
      resolve,
    })
    assert.equal(out.length, 1)
    assert.ok(!out[0]!.summary.includes("reqs"))
  })
})

describe("groupRows with an empty group", () => {
  it("skips a group with no visible accounts", () => {
    const out = groupRows({
      groups: {
        fresh: { accounts: [], label: "Fresh" },
        main: { accounts: ["acme-1"] },
      },
      accounts: ACCOUNTS,
      quota: {},
      resolve,
    })
    assert.deepEqual(
      out.map((s) => s.title),
      ["main", "Other"],
    )
  })
})

describe("memberName", () => {
  it("drops the group's name from a member's", () => {
    assert.equal(memberName("Main", "Main - Team 1"), "Team 1")
    assert.equal(memberName("Alt", "alt: Team 2"), "Team 2")
    assert.equal(memberName("Main", "Mainframe"), "Mainframe")
  })
  it("keeps a name that does not start with the group's, or would be empty", () => {
    assert.equal(memberName("Alt", "Main - Team 1"), "Main - Team 1")
    assert.equal(memberName("Main", "Main"), "Main")
  })
})
