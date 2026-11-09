import { test } from "node:test"
import assert from "node:assert/strict"
import { probeTargets } from "./quota.ts"

const now = 1_000_000_000_000
const acct = (
  source: string,
  expiresAt: number,
  accessToken = "tok-" + source,
) => ({
  source,
  credentials: { accessToken, expiresAt },
})

test("fresh tokens are used as they are, without renewing", () => {
  let renewed = 0
  const out = probeTargets(
    [acct("a", now + 3_600_000)],
    () => (renewed++, null),
    now,
  )
  assert.deepEqual(out, [{ source: "a", accessToken: "tok-a" }])
  assert.equal(renewed, 0)
})

test("an expired token is renewed before the probe uses it", () => {
  const out = probeTargets(
    [acct("idle", now - 31_000_000)],
    () => ({ accessToken: "new", expiresAt: now + 3_600_000 }),
    now,
  )
  assert.deepEqual(out, [{ source: "idle", accessToken: "new" }])
})

test("an account that cannot be renewed is left out, not probed with a dead token", () => {
  const out = probeTargets(
    [acct("dead", now - 1000), acct("ok", now + 3_600_000)],
    (a) => {
      if (a.source === "dead") throw new Error("refresh failed")
      return null
    },
    now,
  )
  assert.deepEqual(
    out.map((t) => t.source),
    ["ok"],
  )
})

test("accounts with no token are skipped", () => {
  assert.deepEqual(
    probeTargets([{ source: "x", credentials: {} }], () => null, now),
    [],
  )
})
