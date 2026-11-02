import { describe, it } from "node:test"
import assert from "node:assert/strict"

import type { AccountId } from "../config.ts"
import type { IdentityCache } from "./identity.ts"
import {
  accountIdFor,
  cacheReadKeys,
  slug,
  sourceForId,
  suggestIds,
} from "./accounts-id.ts"

// One login (same email) present in two different orgs: the pair differs by org.
const sameEmailTwoOrgs: IdentityCache = {
  "src-org1": {
    accountUuid: "acc-1",
    orgUuid: "org-1",
    email: "a@example.com",
    orgName: "Org One",
    fetchedAt: 1,
  },
  "src-org2": {
    accountUuid: "acc-1",
    orgUuid: "org-2",
    email: "a@example.com",
    orgName: "Org Two",
    fetchedAt: 1,
  },
}

// Two different logins inside one org: the pair differs by account.
const twoLoginsOneOrg: IdentityCache = {
  "src-login-a": {
    accountUuid: "acc-a",
    orgUuid: "org-x",
    email: "alice@example.com",
    orgName: "Acme",
    fetchedAt: 1,
  },
  "src-login-b": {
    accountUuid: "acc-b",
    orgUuid: "org-x",
    email: "bob@example.com",
    orgName: "Acme",
    fetchedAt: 1,
  },
}

describe("slug", () => {
  it("lowercases and dashes", () => {
    assert.equal(slug("Org One!"), "org-one")
    assert.equal(slug("  "), "account")
  })
})

describe("accountIdFor", () => {
  it("distinguishes one login across two orgs", () => {
    const registry: Record<string, AccountId> = {
      one: { match: { account: "acc-1", org: "org-1" } },
      two: { match: { account: "acc-1", org: "org-2" } },
    }
    assert.equal(accountIdFor("src-org1", sameEmailTwoOrgs, registry), "one")
    assert.equal(accountIdFor("src-org2", sameEmailTwoOrgs, registry), "two")
  })

  it("distinguishes two logins in one org", () => {
    const registry: Record<string, AccountId> = {
      a: { match: { account: "acc-a", org: "org-x" } },
      b: { match: { account: "acc-b", org: "org-x" } },
    }
    assert.equal(accountIdFor("src-login-a", twoLoginsOneOrg, registry), "a")
    assert.equal(accountIdFor("src-login-b", twoLoginsOneOrg, registry), "b")
  })

  it("falls back to the source when unregistered", () => {
    assert.equal(accountIdFor("src-org1", sameEmailTwoOrgs, {}), "src-org1")
  })
})

describe("sourceForId", () => {
  it("reverses through the identity cache", () => {
    const registry: Record<string, AccountId> = {
      two: { match: { account: "acc-1", org: "org-2" } },
    }
    assert.equal(sourceForId("two", sameEmailTwoOrgs, registry), "src-org2")
    assert.equal(sourceForId("missing", sameEmailTwoOrgs, registry), undefined)
  })
})

describe("suggestIds", () => {
  it("gives a clean slug to a lone account", () => {
    const only: IdentityCache = {
      src: { accountUuid: "a", orgUuid: "o", orgName: "Org One", fetchedAt: 1 },
    }
    assert.deepEqual(suggestIds(["src"], only, {}), [
      { source: "src", id: "org-one" },
    ])
  })

  it("suffixes a same-org clash by email local part", () => {
    const s = suggestIds(["src-login-a", "src-login-b"], twoLoginsOneOrg, {})
    assert.deepEqual(s, [
      { source: "src-login-a", id: "acme-alice" },
      { source: "src-login-b", id: "acme-bob" },
    ])
  })

  it("suffixes numerically when no email tells them apart", () => {
    const noEmail: IdentityCache = {
      s1: { accountUuid: "a", orgUuid: "x", orgName: "Acme", fetchedAt: 1 },
      s2: { accountUuid: "b", orgUuid: "y", orgName: "Acme", fetchedAt: 1 },
    }
    assert.deepEqual(suggestIds(["s1", "s2"], noEmail, {}), [
      { source: "s1", id: "acme" },
      { source: "s2", id: "acme-2" },
    ])
  })

  it("never reuses an id already in the registry", () => {
    const only: IdentityCache = {
      src: { accountUuid: "a", orgUuid: "o", orgName: "Acme", fetchedAt: 1 },
    }
    const s = suggestIds(["src"], only, {
      acme: { match: { account: "z", org: "z" } },
    })
    assert.deepEqual(s, [{ source: "src", id: "acme-2" }])
  })

  it("skips accounts that already resolve to an id", () => {
    const registry: Record<string, AccountId> = {
      a: { match: { account: "acc-a", org: "org-x" } },
    }
    assert.deepEqual(
      suggestIds(["src-login-a", "src-login-b"], twoLoginsOneOrg, registry),
      [{ source: "src-login-b", id: "acme" }],
    )
  })
})

describe("cacheReadKeys", () => {
  it("tries id then source when registered", () => {
    const registry: Record<string, AccountId> = {
      one: { match: { account: "acc-1", org: "org-1" } },
    }
    assert.deepEqual(cacheReadKeys("src-org1", sameEmailTwoOrgs, registry), [
      "one",
      "src-org1",
    ])
  })

  it("is just the source when unregistered", () => {
    assert.deepEqual(cacheReadKeys("src-org1", sameEmailTwoOrgs, {}), [
      "src-org1",
    ])
  })
})
