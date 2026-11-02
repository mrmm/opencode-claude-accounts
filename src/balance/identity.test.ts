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
    writeIdentity("src-a", { accountUuid: "a", orgUuid: "o" }, 1, p)
    const r = await fetchIdentities([{ source: "src-a", accessToken: "tok" }], {
      fetchImpl: okFetch(PROFILE),
      path: p,
      now: () => 7,
    })
    assert.deepEqual(r, { fetched: 0, cached: 1, failed: 0 })
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
