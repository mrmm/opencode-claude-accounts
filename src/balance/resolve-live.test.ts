/**
 * Regression for the live path: preset references written as account ids must
 * resolve through the real config file and identity cache, not only through
 * ids attached to members.
 */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, before, describe, it } from "node:test"

import { DEFAULT_CONFIG, resetConfigCache } from "../config.ts"
import {
  liveIdToSource,
  resolveAccountRefs,
  selectAccount,
} from "./balancer.ts"
import { resolveForSession, resetBindings } from "./sessions.ts"

describe("resolveRef against config + identity cache on disk", () => {
  const home = process.env.HOME
  before(() => {
    const dir = mkdtempSync(join(tmpdir(), "resolve-live-"))
    mkdirSync(join(dir, ".config", "opencode"), { recursive: true })
    mkdirSync(join(dir, ".local", "share", "opencode"), { recursive: true })
    writeFileSync(
      join(dir, ".config", "opencode", "claude-auth.jsonc"),
      JSON.stringify({
        accountIds: {
          "acme-1": { match: { account: "acc-1", org: "org-1" } },
          "acme-2": { match: { account: "acc-2", org: "org-1" } },
        },
      }),
    )
    writeFileSync(
      join(dir, ".local", "share", "opencode", "claude-auth-identities.json"),
      JSON.stringify({
        "src-1": { accountUuid: "acc-1", orgUuid: "org-1", fetchedAt: 1 },
        "src-2": { accountUuid: "acc-2", orgUuid: "org-1", fetchedAt: 1 },
      }),
    )
    process.env.HOME = dir
    resetConfigCache()
  })
  after(() => {
    process.env.HOME = home
    resetConfigCache()
  })

  it("maps ids to Keychain sources", () => {
    assert.equal(liveIdToSource("acme-2"), "src-2")
    assert.equal(liveIdToSource("nope"), undefined)
  })

  it("resolves a migrated preset with id-less members", () => {
    const members = [{ source: "src-1" }, { source: "src-2" }]
    assert.deepEqual(resolveAccountRefs(["acme-1", "acme-2"], members), {
      sources: ["src-1", "src-2"],
      unresolved: [],
    })
  })

  // Regression for the 429 with spare quota: a preset of ids, members without
  // ids, its first account spent. Before the fix the pool resolved empty, no
  // account was selected, and the session fell back to the spent global one.
  it("routes a session off a spent account in an id preset", () => {
    const now = Date.now()
    const sec = Math.floor(now / 1000)
    const quota = {
      "acme-1": {
        sevenDay: { utilization: 1, resetsAt: sec + 86400 },
        representative: "seven_day",
        observedAt: sec,
      },
      "acme-2": {
        fiveHour: { utilization: 0.3, resetsAt: sec + 3600 },
        representative: "five_hour",
        observedAt: sec,
      },
    }
    const members = [{ source: "src-1" }, { source: "src-2" }]
    const cfg = {
      ...DEFAULT_CONFIG,
      accounts: ["acme-1", "acme-2"],
      strategy: "round-robin" as const,
    }
    assert.equal(
      selectAccount(members, quota as never, cfg, "src-1", now)?.source,
      "src-2",
    )
    resetBindings()
    const d = resolveForSession("ses-x", members, quota as never, cfg, now)
    assert.equal(d?.source, "src-2")
  })
})
