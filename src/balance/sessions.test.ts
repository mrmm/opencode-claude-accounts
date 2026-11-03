import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, it } from "node:test"

import { DEFAULT_CONFIG, type ClaudeAuthConfig } from "../config.ts"
import type { AccountQuota, QuotaCache } from "./quota.ts"
import { resetCursors, resetEjections, type Member } from "./balancer.ts"
import {
  SESSION_HEADER,
  bindSession,
  boundSource,
  forgetSession,
  listBindings,
  resetBindings,
  resolveForSession,
  creditsDenied,
  denyCredits,
  allowCredits,
  resetCreditDenials,
  allowReserve,
  revokeReserve,
  reserveAllowed,
  resetReserveAllows,
} from "./sessions.ts"

// These tests write the reserve and credit-denial files under HOME; point it
// at a temp dir so a test run never edits the operator's real state. Each test
// file runs in its own process, and the child spawned below inherits it.
process.env.HOME = mkdtempSync(join(tmpdir(), "sessions-home-"))

const NOW = 1785162626000
const SEC = Math.floor(NOW / 1000)

const reading = (u: number): AccountQuota => ({
  fiveHour: { utilization: u, resetsAt: SEC + 3600 },
  representative: "five_hour",
  observedAt: SEC,
})

const members = (...s: string[]): Member[] =>
  s.map((x) => ({ source: x, label: x, credential: "ok" as const }))

const cfg = (o: Partial<ClaudeAuthConfig> = {}): ClaudeAuthConfig => ({
  ...DEFAULT_CONFIG,
  ...o,
})

beforeEach(() => {
  resetBindings()
  resetCursors()
  resetEjections()
})

describe("session bindings", () => {
  it("keeps a session on its account across requests", () => {
    const cache: QuotaCache = { a: reading(0.1), b: reading(0.1) }
    const first = resolveForSession("s1", members("a", "b"), cache, cfg(), NOW)
    const second = resolveForSession("s1", members("a", "b"), cache, cfg(), NOW)
    assert.equal(second!.source, first!.source)
    assert.equal(second!.changed, false)
    assert.equal(second!.reason, "already bound")
  })

  it("gives two sessions different accounts under round-robin", () => {
    // The point of the feature: parallel subagents arrive as separate sessions.
    const cache: QuotaCache = { a: reading(0.1), b: reading(0.1) }
    const c = cfg({ strategy: "round-robin", accounts: ["a", "b"] })
    const s1 = resolveForSession("s1", members("a", "b"), cache, c, NOW)
    const s2 = resolveForSession("s2", members("a", "b"), cache, c, NOW)
    assert.notEqual(s1!.source, s2!.source)
  })

  it("moves only the session whose account is spent", () => {
    const healthy: QuotaCache = { a: reading(0.1), b: reading(0.1) }
    const c = cfg({ strategy: "round-robin", accounts: ["a", "b"] })
    const s1 = resolveForSession("s1", members("a", "b"), healthy, c, NOW)!
    const s2 = resolveForSession("s2", members("a", "b"), healthy, c, NOW)!

    // Spend whatever s1 landed on; s2 must not be disturbed.
    const spent: QuotaCache = { ...healthy, [s1.source]: reading(1) }
    const s1b = resolveForSession("s1", members("a", "b"), spent, c, NOW)!
    const s2b = resolveForSession("s2", members("a", "b"), spent, c, NOW)!
    assert.notEqual(s1b.source, s1.source, "s1 should have moved")
    assert.equal(s2b.source, s2.source, "s2 should be untouched")
  })

  it("rebinds when the bound account becomes unusable", () => {
    const cache: QuotaCache = { a: reading(0.1), b: reading(0.1) }
    bindSession("s1", "a", NOW)
    const spent: QuotaCache = { ...cache, a: reading(1) }
    const d = resolveForSession("s1", members("a", "b"), spent, cfg(), NOW)!
    assert.equal(d.source, "b")
    assert.equal(d.changed, true)
    assert.match(d.reason, /rebound/)
  })

  it("forgets a session on request", () => {
    bindSession("s1", "a", NOW)
    assert.equal(boundSource("s1"), "a")
    forgetSession("s1")
    assert.equal(boundSource("s1"), undefined)
  })

  it("cache-aware routing: an existing session stays put while new ones spread (T1)", () => {
    // Round-robin over three accounts. One long-running session must keep its
    // account across 50 turns -- that is what keeps its prompt cache warm --
    // while fresh sessions rotate across all three. This proves the rotating
    // strategy applies only to NEW or unhealthy sessions, never moving a bound
    // one that is still healthy.
    const cache: QuotaCache = {
      a: reading(0.1),
      b: reading(0.1),
      c: reading(0.1),
    }
    const c = cfg({ strategy: "round-robin", accounts: ["a", "b", "c"] })
    const mem = members("a", "b", "c")

    // The long-running session binds first.
    const bound = resolveForSession("long", mem, cache, c, NOW)!.source

    const spread = new Set<string>()
    for (let turn = 0; turn < 50; turn++) {
      // The long session takes its turn, interleaved with a brand-new session.
      const again = resolveForSession("long", mem, cache, c, NOW + turn * 1000)!
      assert.equal(again.source, bound, `turn ${turn}: long session moved`)
      assert.equal(again.changed, false)

      const fresh = resolveForSession(
        `new-${turn}`,
        mem,
        cache,
        c,
        NOW + turn * 1000,
      )!
      spread.add(fresh.source)
    }

    // New sessions reached more than one account; the bound one never budged.
    assert.ok(
      spread.size >= 2,
      `new sessions spread across ${spread.size} accounts`,
    )
    assert.equal(boundSource("long"), bound)
  })

  it("sweeps a session idle for over an hour", () => {
    bindSession("old", "a", NOW)
    bindSession("new", "b", NOW + 2 * 60 * 60_000)
    assert.equal(boundSource("old"), undefined)
    assert.equal(boundSource("new"), "b")
  })

  it("reports its bindings", () => {
    bindSession("s1", "a", NOW)
    assert.deepEqual(listBindings(), [{ sessionId: "s1", source: "a" }])
  })

  it("returns nothing when there are no accounts", () => {
    assert.equal(resolveForSession("s1", [], {}, cfg(), NOW), undefined)
  })

  it("uses a header name that cannot collide with Anthropic's", () => {
    assert.match(SESSION_HEADER, /^x-claude-auth-/)
  })
})

describe("a session can decline paid overflow", () => {
  const paid = (u: number) => ({
    ...reading(u, u >= 1 ? { status: "rejected" } : {}),
    extra: {
      enabled: true,
      capReached: false,
      usedMinor: 100,
      limitMinor: 20000,
    },
  })

  it("narrows only its own view, leaving other sessions alone", () => {
    resetBindings()
    resetCreditDenials()
    const cache: QuotaCache = { a: paid(1.0), b: paid(1.01) }

    denyCredits("thrifty")
    const thrifty = resolveForSession(
      "thrifty",
      members("a", "b"),
      cache,
      cfg(),
      NOW,
    )
    const spender = resolveForSession(
      "spender",
      members("a", "b"),
      cache,
      cfg(),
      NOW,
    )

    assert.equal(creditsDenied("thrifty"), true)
    assert.equal(creditsDenied("spender"), false)
    // SessionDecision has no `pool`; the tier shows through in the reason.
    assert.match(
      thrifty!.reason,
      /in exhausted/,
      "declined, so it is told there is nothing free left",
    )
    assert.match(
      spender!.reason,
      /in credits/,
      "the global setting still governs every other session",
    )
    resetCreditDenials()
  })

  it("can change its mind", () => {
    resetCreditDenials()
    denyCredits("s1")
    assert.equal(creditsDenied("s1"), true)
    allowCredits("s1")
    assert.equal(creditsDenied("s1"), false)
  })
})

describe("a credit denial crosses the process boundary", () => {
  // The balancer runs in the server and the dialogs in the TUI worker. An
  // in-memory flag set by one is invisible to the other, which made the
  // setting unreachable from the only surface that would set it.
  it("is readable after the writing process is gone", () => {
    resetCreditDenials()
    denyCredits("crosser")
    const seen = execFileSync(
      process.execPath,
      [
        "-e",
        'import("./dist/balance/index.js").then((m) => console.log(m.creditsDenied("crosser")))',
      ],
      { encoding: "utf8", cwd: process.cwd() },
    ).trim()
    assert.equal(seen, "true")
    resetCreditDenials()
  })

  it("expires on the same idle rule as a binding", () => {
    resetCreditDenials()
    denyCredits("stale")
    const p = join(
      homedir(),
      ".local/share/opencode/claude-auth/credit-denials.json",
    )
    // Backdate past the idle window rather than waiting an hour for it.
    writeFileSync(p, JSON.stringify({ stale: Date.now() - 2 * 60 * 60_000 }))
    assert.equal(creditsDenied("stale"), false, "an hour idle, so forgotten")
    resetCreditDenials()
  })
})

describe("the reserved-quota session override", () => {
  const capped = (): ClaudeAuthConfig =>
    cfg({
      capMode: "hard",
      accountIds: {
        a: { match: { account: "a", org: "o" }, maxUsage: { "5h": 0.8 } },
      },
    })
  const idMembers = (...s: string[]): Member[] =>
    s.map((x) => ({ source: x, label: x, id: x, credential: "ok" as const }))

  it("releases a reserve for only the opted-in session", () => {
    resetBindings()
    resetReserveAllows()
    const cache: QuotaCache = { a: reading(0.85) }

    allowReserve("opted-in")
    const inSession = resolveForSession(
      "opted-in",
      idMembers("a"),
      cache,
      capped(),
      NOW,
    )
    const other = resolveForSession(
      "other",
      idMembers("a"),
      cache,
      capped(),
      NOW,
    )

    assert.equal(reserveAllowed("opted-in"), true)
    assert.equal(reserveAllowed("other"), false)
    // Hard mode: only the opted-in session reaches the reserved account.
    assert.match(inSession!.reason, /reserved/)
    assert.doesNotMatch(other!.reason, /reserved/)
    resetReserveAllows()
  })

  it("can be revoked", () => {
    resetReserveAllows()
    allowReserve("s1")
    assert.equal(reserveAllowed("s1"), true)
    revokeReserve("s1")
    assert.equal(reserveAllowed("s1"), false)
  })

  it("expires on the same idle rule", () => {
    resetReserveAllows()
    allowReserve("stale")
    const p = join(
      homedir(),
      ".local/share/opencode/claude-auth/reserve-allows.json",
    )
    writeFileSync(p, JSON.stringify({ stale: Date.now() - 2 * 60 * 60_000 }))
    assert.equal(reserveAllowed("stale"), false)
    resetReserveAllows()
  })
})
