import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  fetchIdentities,
  parseProfile,
  readIdentityCache,
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
