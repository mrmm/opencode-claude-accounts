import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { stripJsonc } from "../config.ts"
import type { Member } from "./balancer.ts"
import {
  applyMigration,
  backupStamp,
  membersForMigration,
  planMigration,
} from "./migrate.ts"

const members: Member[] = [
  { source: "src-1", id: "acme-1", label: "Team 1" },
  { source: "src-2", id: "acme-2", label: "Team 2" },
]

const pairFor = (source: string) =>
  source === "src-1"
    ? { account: "acc-1", org: "org-1" }
    : source === "src-2"
      ? { account: "acc-2", org: "org-2" }
      : undefined

describe("planMigration", () => {
  it("rewrites every reference kind to ids", () => {
    const raw = {
      accounts: ["Team 1", "src-2"],
      weights: { "Team 1": 3 },
      accountNames: { "src-1": "One", "Team 2": "Two" },
      presets: {
        rr: {
          accounts: ["Team 1", "Team 2"],
          pools: [{ accounts: ["src-1"], weights: { "Team 2": 2 } }],
        },
      },
      pools: [{ accounts: ["Team 1"] }],
    }
    const plan = planMigration(raw, members, pairFor)
    assert.equal(plan.changed, true)
    assert.deepEqual(plan.accounts, ["acme-1", "acme-2"])
    assert.deepEqual(plan.weights, { "acme-1": 3 })
    assert.deepEqual(plan.accountNames, { "acme-1": "One", "acme-2": "Two" })
    const preset = plan.presets?.rr as {
      accounts: string[]
      pools: { accounts: string[]; weights: Record<string, number> }[]
    }
    assert.deepEqual(preset.accounts, ["acme-1", "acme-2"])
    assert.deepEqual(preset.pools[0]?.accounts, ["acme-1"])
    assert.deepEqual(preset.pools[0]?.weights, { "acme-2": 2 })
    const pools = plan.pools as { accounts: string[] }[]
    assert.deepEqual(pools[0]?.accounts, ["acme-1"])
  })

  it("builds the id registry with names from accountNames", () => {
    const plan = planMigration(
      { accountNames: { "Team 1": "One" } },
      members,
      pairFor,
    )
    assert.deepEqual(plan.accountIds, {
      "acme-1": { match: { account: "acc-1", org: "org-1" }, name: "One" },
      "acme-2": { match: { account: "acc-2", org: "org-2" } },
    })
  })

  it("leaves an unresolvable reference verbatim", () => {
    const plan = planMigration({ accounts: ["ghost"] }, members, pairFor)
    assert.deepEqual(plan.accounts, ["ghost"])
  })
})

function tmpConfig(body: string): string {
  const path = join(
    mkdtempSync(join(tmpdir(), "migrate-")),
    "claude-auth.jsonc",
  )
  writeFileSync(path, body, "utf8")
  return path
}

describe("applyMigration", () => {
  it("rewrites the file, backs it up, and is idempotent", () => {
    const original = `{
  // keep me
  "accounts": ["Team 1", "Team 2"],
  "presets": { "rr": { "accounts": ["Team 1"] } }
}
`
    const path = tmpConfig(original)
    const first = applyMigration(
      path,
      members,
      pairFor,
      new Date(2026, 0, 2, 3, 4),
    )
    assert.equal(first.migrated, true)
    assert.ok(first.backupPath?.endsWith(".bak-20260102-0304"))
    assert.equal(readFileSync(first.backupPath!, "utf8"), original)
    // Written via tmp + rename: no temp file survives a successful migration.
    assert.ok(!readdirSync(dirname(path)).some((f) => f.includes(".tmp-")))

    const after = JSON.parse(stripJsonc(readFileSync(path, "utf8"))) as {
      accounts: string[]
      accountIds: Record<string, unknown>
      presets: { rr: { accounts: string[] } }
    }
    assert.deepEqual(after.accounts, ["acme-1", "acme-2"])
    assert.deepEqual(after.presets.rr.accounts, ["acme-1"])
    assert.ok("acme-1" in after.accountIds)
    // Comments on untouched keys survive.
    assert.ok(readFileSync(path, "utf8").includes("// keep me"))

    // Second run finds only id references and the existing registry: no backup.
    const before = readdirSync(join(path, "..")).length
    const second = applyMigration(path, members, pairFor)
    assert.equal(second.migrated, false)
    assert.equal(readdirSync(join(path, "..")).length, before)
  })

  it("does nothing for a missing file", () => {
    assert.deepEqual(applyMigration("/no/such/file", members, pairFor), {
      migrated: false,
      mapping: {},
    })
  })
})

describe("membersForMigration", () => {
  const identities = {
    "src-1": {
      accountUuid: "acc-1",
      orgUuid: "org-1",
      orgName: "Acme",
      fetchedAt: 1,
    },
    "src-2": {
      accountUuid: "acc-2",
      orgUuid: "org-1",
      orgName: "Acme",
      email: "b@example.com",
      fetchedAt: 1,
    },
  }
  const accounts = [
    { source: "src-1", label: "Team 1" },
    { source: "src-2", label: "Team 2" },
    { source: "src-3", label: "Expired" },
  ]

  it("gives bare accounts suggested ids so the plan registers them", () => {
    const m = membersForMigration(accounts, identities, {})
    assert.ok(m[0]?.id && m[1]?.id && m[0].id !== m[1].id)
    assert.equal(m[2]?.id, undefined, "no identity, no id")
    const pair = (s: string) => {
      const i = identities[s as keyof typeof identities]
      return i ? { account: i.accountUuid, org: i.orgUuid } : undefined
    }
    const plan = planMigration(
      { accounts: ["src-1", "Team 2", "src-3"] },
      m,
      pair,
    )
    assert.equal(Object.keys(plan.accountIds).length, 2)
    assert.deepEqual(plan.accounts, [m[0]!.id, m[1]!.id, "src-3"])
  })

  it("keeps an already registered id", () => {
    const registry = { mine: { match: { account: "acc-1", org: "org-1" } } }
    assert.equal(
      membersForMigration(accounts, identities, registry)[0]?.id,
      "mine",
    )
  })
})

describe("backupStamp", () => {
  it("is YYYYMMDD-HHmm", () => {
    assert.equal(backupStamp(new Date(2026, 10, 2, 9, 5)), "20261102-0905")
  })
})
