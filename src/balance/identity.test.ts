import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  buildProfileRequest,
  fetchIdentities,
  identityFromConfigDir,
  parseProfile,
  readIdentityCache,
  readIdentityCacheFresh,
  writeIdentity,
} from "./identity.ts"

const PROFILE = {
  account: {
    uuid: "00000000-0000-0000-0000-000000000001",
    email_address: "a@example.com",
  },
  organization: {
    uuid: "00000000-0000-0000-0000-0000000000a1",
    name: "Acme",
  },
}

// The shape the profile endpoint returns today.
const PRO_PROFILE = {
  account: { uuid: PROFILE.account.uuid, email: "b@example.com" },
  organization: {
    uuid: PROFILE.organization.uuid,
    name: "Acme",
    organization_type: "claude_team",
    rate_limit_tier: "default_claude_max_5x",
    subscription_status: "active",
  },
}

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "ident-")), "identities.json")
}

function okFetch(body: unknown): typeof fetch {
  return (async () => ({ status: 200, json: async () => body })) as never
}

describe("parseProfile", () => {
  it("pulls the pair, email and org name", () => {
    assert.deepEqual(parseProfile(PROFILE), {
      accountUuid: "00000000-0000-0000-0000-000000000001",
      orgUuid: "00000000-0000-0000-0000-0000000000a1",
      email: "a@example.com",
      orgName: "Acme",
    })
  })

  // Regression: the endpoint says `email`, and only `email_address` was read.
  it("reads the email and the plan the endpoint returns today", () => {
    assert.deepEqual(parseProfile(PRO_PROFILE), {
      accountUuid: PROFILE.account.uuid,
      orgUuid: PROFILE.organization.uuid,
      email: "b@example.com",
      orgName: "Acme",
      plan: "claude_team",
      tier: "default_claude_max_5x",
      subscription: "active",
    })
  })

  it("rejects a body missing either uuid", () => {
    assert.equal(parseProfile({ account: { uuid: "x" } }), undefined)
    assert.equal(parseProfile(null), undefined)
  })
})

describe("writeIdentity / readIdentityCache", () => {
  it("round-trips, keyed by source, with fetchedAt", () => {
    const p = tmpFile()
    writeIdentity(
      "src-a",
      { accountUuid: "a", orgUuid: "o", email: "a@example.com" },
      1234,
      p,
    )
    const cache = readIdentityCache(p)
    assert.deepEqual(cache["src-a"], {
      accountUuid: "a",
      orgUuid: "o",
      email: "a@example.com",
      fetchedAt: 1234,
    })
  })
})

describe("fetchIdentities", () => {
  it("fetches, writes, and counts", async () => {
    const p = tmpFile()
    const r = await fetchIdentities([{ source: "src-a", accessToken: "tok" }], {
      fetchImpl: okFetch(PROFILE),
      path: p,
      now: () => 7,
    })
    assert.deepEqual(r, { fetched: 1, cached: 0, failed: 0 })
    assert.equal(readIdentityCache(p)["src-a"]?.orgName, "Acme")
  })

  it("skips an account already cached", async () => {
    const p = tmpFile()
    writeIdentity(
      "src-a",
      { accountUuid: "a", orgUuid: "o", plan: "claude_team" },
      1,
      p,
    )
    const r = await fetchIdentities([{ source: "src-a", accessToken: "tok" }], {
      fetchImpl: okFetch(PROFILE),
      path: p,
      now: () => 7,
    })
    assert.deepEqual(r, { fetched: 0, cached: 1, failed: 0 })
  })

  // Regression: rows were cached forever, so plan and subscription could
  // never appear for an account fetched before they were kept.
  it("refreshes a day-old or plan-less row from the profile", async () => {
    const p = tmpFile()
    const pair = {
      accountUuid: PROFILE.account.uuid,
      orgUuid: PROFILE.organization.uuid,
    }
    writeIdentity("src-a", pair, 1, p)
    const r = await fetchIdentities([{ source: "src-a", accessToken: "tok" }], {
      fetchImpl: okFetch(PRO_PROFILE),
      path: p,
      now: () => 7,
    })
    assert.deepEqual(r, { fetched: 1, cached: 0, failed: 0 })
    assert.equal(readIdentityCache(p)["src-a"]?.plan, "claude_team")
  })

  it("never rekeys or downgrades a held row on refresh", async () => {
    const p = tmpFile()
    const held = { accountUuid: "a", orgUuid: "o", email: "held@example.com" }
    writeIdentity("src-a", held, 1, p)
    const expired = (async () => ({
      status: 401,
      json: async () => null,
    })) as never
    for (const fetchImpl of [expired, okFetch(PRO_PROFILE), okFetch(null)]) {
      const r = await fetchIdentities(
        [{ source: "src-a", accessToken: "tok", configDir: "/nonexistent" }],
        { fetchImpl, path: p, now: () => 7 },
      )
      assert.deepEqual(r, { fetched: 0, cached: 1, failed: 0 })
      assert.equal(readIdentityCache(p)["src-a"]?.email, "held@example.com")
    }
  })

  it("keeps a cached identity when the token is expired (401)", async () => {
    const p = tmpFile()
    const boom = (async () => ({
      status: 401,
      json: async () => null,
    })) as never
    const r = await fetchIdentities([{ source: "src-a", accessToken: "tok" }], {
      fetchImpl: boom,
      path: p,
    })
    assert.deepEqual(r, { fetched: 0, cached: 0, failed: 1 })
    assert.equal(readIdentityCache(p)["src-a"], undefined)
  })

  it("never throws on a network error", async () => {
    const p = tmpFile()
    const boom = (async () => {
      throw new Error("down")
    }) as never
    assert.deepEqual(
      await fetchIdentities([{ source: "src-a", accessToken: "t" }], {
        fetchImpl: boom,
        path: p,
      }),
      { fetched: 0, cached: 0, failed: 1 },
    )
  })

  it("leaves no partial file when there is nothing to write", async () => {
    const p = tmpFile()
    await fetchIdentities([], { path: p })
    assert.throws(() => readFileSync(p, "utf8"))
  })
})

describe("readIdentityCacheFresh", () => {
  it("serves the cached read until the file changes", () => {
    const path = join(mkdtempSync(join(tmpdir(), "idf-")), "ids.json")
    writeFileSync(
      path,
      JSON.stringify({ a: { accountUuid: "1", orgUuid: "o", fetchedAt: 1 } }),
    )
    assert.equal(readIdentityCacheFresh(path).a?.accountUuid, "1")
    writeFileSync(
      path,
      JSON.stringify({ a: { accountUuid: "2", orgUuid: "o", fetchedAt: 2 } }),
    )
    utimesSync(path, new Date(), new Date(Date.now() + 5_000))
    assert.equal(readIdentityCacheFresh(path).a?.accountUuid, "2")
  })

  it("leaves no temp file behind after a write", () => {
    const dir = mkdtempSync(join(tmpdir(), "idw-"))
    writeIdentity(
      "s",
      { accountUuid: "1", orgUuid: "o" },
      1,
      join(dir, "ids.json"),
    )
    assert.deepEqual(readdirSync(dir), ["ids.json"])
  })
})

describe("identity hardening", () => {
  it("does not borrow ~/.claude.json for a non-default config dir", () => {
    const home = mkdtempSync(join(tmpdir(), "idh-"))
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        oauthAccount: { accountUuid: "u", organizationUuid: "o" },
      }),
    )
    const prior = process.env.HOME
    process.env.HOME = home
    try {
      assert.equal(identityFromConfigDir(join(home, "other")), undefined)
      assert.equal(
        identityFromConfigDir(join(home, ".claude"))?.accountUuid,
        "u",
      )
    } finally {
      process.env.HOME = prior
    }
  })

  it("writes the identity cache owner-only", () => {
    const path = join(mkdtempSync(join(tmpdir(), "idm-")), "ids.json")
    writeIdentity("s", { accountUuid: "1", orgUuid: "o" }, 1, path)
    assert.equal(statSync(path).mode & 0o777, 0o600)
  })

  it("bounds the profile request with a timeout", () => {
    assert.ok(buildProfileRequest("t")[1].signal instanceof AbortSignal)
  })
})

// Regression: profiles were fetched one after another, so N accounts cost N
// round trips at start-up.
describe("fetchIdentities concurrency", () => {
  it("issues every profile request before the first one answers", async () => {
    const p = tmpFile()
    let inFlight = 0
    let peak = 0
    const slow = (async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 20))
      inFlight--
      return new Response(JSON.stringify(PROFILE), { status: 200 })
    }) as unknown as typeof fetch
    const r = await fetchIdentities(
      ["a", "b", "c"].map((s) => ({ source: s, accessToken: "t" })),
      { fetchImpl: slow, path: p, now: () => 1 },
    )
    assert.equal(peak, 3)
    assert.deepEqual(r, { fetched: 3, cached: 0, failed: 0 })
    assert.equal(Object.keys(readIdentityCache(p)).length, 3)
  })
})
