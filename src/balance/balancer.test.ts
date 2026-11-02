import assert from "node:assert/strict"
import { beforeEach, describe, it } from "node:test"

import { DEFAULT_CONFIG, type ClaudeAuthConfig } from "../config.ts"
import type { AccountQuota, QuotaCache } from "./quota.ts"
import {
  assess,
  eject,
  clearEjection,
  ejectedUntil,
  resetCursors,
  STRATEGIES,
  resetEjections,
  orderByConfig,
  resolveAccountRefs,
  resolvePools,
  resolveRef,
  recoveryTimes,
  spentRetry,
  usageOf,
  selectAccount,
  type Member,
} from "./balancer.ts"
import { resolveActiveConfig } from "./rotate.ts"

const NOW_MS = 1785162626000
const NOW_SEC = Math.floor(NOW_MS / 1000)

const members = (...sources: string[]): Member[] =>
  sources.map((s) => ({ source: s, label: s }))

/** A reading with the given 5h utilisation, observed now, resetting in an hour. */
function reading(
  utilization: number,
  opts: { status?: string; resetsIn?: number } = {},
): AccountQuota {
  return {
    fiveHour: {
      utilization,
      status: opts.status,
      resetsAt: NOW_SEC + (opts.resetsIn ?? 3600),
    },
    representative: "five_hour",
    observedAt: NOW_SEC,
  }
}

const cfg = (over: Partial<ClaudeAuthConfig> = {}): ClaudeAuthConfig => ({
  ...DEFAULT_CONFIG,
  ...over,
})

beforeEach(() => {
  resetEjections()
  resetCursors()
})

describe("assess", () => {
  it("calls an account under the threshold healthy", () => {
    const cache: QuotaCache = { a: reading(0.5) }
    const [h] = assess(members("a"), cache, cfg(), NOW_MS)
    assert.equal(h!.healthy, true)
    assert.equal(h!.utilization, 0.5)
  })

  it("calls an account at or above switchAt unhealthy", () => {
    const cache: QuotaCache = { a: reading(0.95) }
    const [h] = assess(members("a"), cache, cfg({ switchAt: 0.95 }), NOW_MS)
    assert.equal(h!.healthy, false)
    assert.match(h!.reason, /95%/)
  })

  it("treats a window past its reset as empty, not spent", () => {
    // The figure describes a window that no longer exists.
    const cache: QuotaCache = { a: reading(1.0, { resetsIn: -60 }) }
    const [h] = assess(members("a"), cache, cfg(), NOW_MS)
    assert.equal(h!.healthy, true)
    assert.equal(h!.utilization, 0)
  })

  it("honours the server's own rejection", () => {
    const cache: QuotaCache = { a: reading(0.4, { status: "rejected" }) }
    const [h] = assess(members("a"), cache, cfg(), NOW_MS)
    assert.equal(h!.healthy, false)
    assert.equal(h!.reason, "server rejected")
  })

  it("assumes an unmeasured account is usable", () => {
    const [h] = assess(members("a"), {}, cfg(), NOW_MS)
    assert.equal(h!.healthy, true)
    assert.equal(h!.utilization, undefined)
  })

  it("respects an active ejection", () => {
    eject("a", cfg(), NOW_MS)
    const [h] = assess(members("a"), { a: reading(0.1) }, cfg(), NOW_MS)
    assert.equal(h!.healthy, false)
    assert.match(h!.reason, /ejected/)
  })

  it("reads the weekly window when told to", () => {
    const cache: QuotaCache = {
      a: {
        fiveHour: { utilization: 0.1, resetsAt: NOW_SEC + 3600 },
        sevenDay: { utilization: 0.99, resetsAt: NOW_SEC + 86400 },
        observedAt: NOW_SEC,
      },
    }
    const on5h = assess(
      members("a"),
      cache,
      cfg({ switchWindow: "5h" }),
      NOW_MS,
    )
    const on7d = assess(
      members("a"),
      cache,
      cfg({ switchWindow: "7d" }),
      NOW_MS,
    )
    assert.equal(on5h[0]!.healthy, true)
    assert.equal(on7d[0]!.healthy, false)
  })
})

describe("reserved ceilings (maxUsage)", () => {
  const capped = (id: string, maxUsage: { "5h"?: number; "7d"?: number }) =>
    cfg({
      accountIds: {
        [id]: { match: { account: id, org: "o" }, maxUsage },
      },
    })

  const idMember = (id: string): Member => ({ source: id, label: id, id })

  it("marks an account past its ceiling reserved, under switchAt", () => {
    const cache: QuotaCache = { a: reading(0.85) }
    const [h] = assess(
      [idMember("a")],
      cache,
      capped("a", { "5h": 0.8 }),
      NOW_MS,
    )
    assert.equal(h!.healthy, false)
    assert.equal(h!.reserved, true)
    assert.match(h!.reason, /reserved: at 85% of 5h \(ceiling 80%\)/)
  })

  it("reserves on a weekly ceiling even while 5h looks fine", () => {
    const cache: QuotaCache = {
      a: {
        fiveHour: { utilization: 0.1, resetsAt: NOW_SEC + 3600 },
        sevenDay: { utilization: 0.7, resetsAt: NOW_SEC + 86400 },
        representative: "five_hour",
        observedAt: NOW_SEC,
      },
    }
    const [h] = assess(
      [idMember("a")],
      cache,
      capped("a", { "7d": 0.6 }),
      NOW_MS,
    )
    assert.equal(h!.reserved, true)
    assert.match(h!.reason, /7d/)
  })

  it("stays healthy below the ceiling", () => {
    const cache: QuotaCache = { a: reading(0.5) }
    const [h] = assess(
      [idMember("a")],
      cache,
      capped("a", { "5h": 0.8 }),
      NOW_MS,
    )
    assert.equal(h!.healthy, true)
  })

  it("in soft mode a reserved account serves as a last resort", () => {
    const cache: QuotaCache = { a: reading(0.85) }
    const d = selectAccount(
      [idMember("a")],
      cache,
      capped("a", { "5h": 0.8 }),
      null,
      NOW_MS,
    )
    assert.equal(d!.pool, "reserved")
    assert.equal(d!.source, "a")
  })

  it("in hard mode a reserved account does not serve without the override", () => {
    const base = capped("a", { "5h": 0.8 })
    const hard = { ...base, capMode: "hard" as const }
    const cache: QuotaCache = { a: reading(0.85) }
    const d = selectAccount([idMember("a")], cache, hard, null, NOW_MS)
    // Falls through to exhausted rather than drawing on the reserve.
    assert.equal(d!.pool, "exhausted")
  })

  it("the session override releases a reserve in hard mode", () => {
    const base = capped("a", { "5h": 0.8 })
    const hard = { ...base, capMode: "hard" as const }
    const cache: QuotaCache = { a: reading(0.85) }
    const d = selectAccount([idMember("a")], cache, hard, null, NOW_MS, {
      allowReserve: true,
    })
    assert.equal(d!.pool, "reserved")
  })

  it("prefers a free account over a reserved one", () => {
    const cache: QuotaCache = { a: reading(0.85), b: reading(0.3) }
    const two = cfg({
      accountIds: {
        a: { match: { account: "a", org: "o" }, maxUsage: { "5h": 0.8 } },
      },
    })
    const d = selectAccount(
      [
        { source: "a", label: "a", id: "a" },
        { source: "b", label: "b", id: "b" },
      ],
      cache,
      two,
      null,
      NOW_MS,
    )
    assert.equal(d!.source, "b")
  })

  it("picks the emptiest reserve by margin past ceiling", () => {
    const cache: QuotaCache = { a: reading(0.95), b: reading(0.85) }
    const two = cfg({
      accountIds: {
        a: { match: { account: "a", org: "o" }, maxUsage: { "5h": 0.8 } },
        b: { match: { account: "b", org: "o" }, maxUsage: { "5h": 0.8 } },
      },
    })
    const d = selectAccount(
      [
        { source: "a", label: "a", id: "a" },
        { source: "b", label: "b", id: "b" },
      ],
      cache,
      two,
      null,
      NOW_MS,
    )
    // b is 5% past its ceiling, a is 15% past: b is the emptier reserve.
    assert.equal(d!.pool, "reserved")
    assert.equal(d!.source, "b")
  })
})

describe("credential health", () => {
  it("refuses an account that cannot authenticate, however much headroom it has", () => {
    const cache: QuotaCache = { a: reading(0.0) }
    const [h] = assess(
      [{ source: "a", credential: "unusable" }],
      cache,
      cfg(),
      NOW_MS,
    )
    assert.equal(h!.healthy, false)
    assert.match(h!.reason, /cannot be refreshed/)
  })

  it("treats a refreshable account as usable", () => {
    const [h] = assess(
      [{ source: "a", credential: "refreshable" }],
      { a: reading(0.1) },
      cfg(),
      NOW_MS,
    )
    assert.equal(h!.healthy, true)
  })

  it("prefers a ready credential over an emptier one that needs refreshing", () => {
    const pair: Member[] = [
      { source: "ready", credential: "ok" },
      { source: "stale", credential: "refreshable" },
    ]
    const cache: QuotaCache = { ready: reading(0.8), stale: reading(0.0) }
    const d = selectAccount(
      pair,
      cache,
      cfg({ strategy: "least-loaded" }),
      null,
      NOW_MS,
    )
    assert.equal(d!.source, "ready")
  })

  it("still uses a refreshable account when it is the only one left", () => {
    const pair: Member[] = [
      { source: "spent", credential: "ok" },
      { source: "stale", credential: "refreshable" },
    ]
    const cache: QuotaCache = { spent: reading(1.0), stale: reading(0.5) }
    const d = selectAccount(pair, cache, cfg(), "spent", NOW_MS)
    assert.equal(d!.source, "stale")
  })

  it("defaults a member with no stated credential to usable", () => {
    const [h] = assess(members("a"), { a: reading(0.1) }, cfg(), NOW_MS)
    assert.equal(h!.credential, "ok")
    assert.equal(h!.healthy, true)
  })
})

describe("ejection", () => {
  it("backs off multiplicatively and forgets once served", () => {
    const c = cfg({ ejectFor: 1000 })
    const first = eject("a", c, NOW_MS)
    assert.equal(first.until, NOW_MS + 1000)
    const second = eject("a", c, NOW_MS)
    assert.equal(second.until, NOW_MS + 2000)

    clearEjection("a")
    assert.equal(ejectedUntil("a", NOW_MS), undefined)
    // The count resets with the entry, so recovery is complete.
    assert.equal(eject("a", c, NOW_MS).until, NOW_MS + 1000)
  })

  it("expires on its own", () => {
    eject("a", cfg({ ejectFor: 1000 }), NOW_MS)
    assert.equal(ejectedUntil("a", NOW_MS + 1001), undefined)
  })
})

describe("resolvePools", () => {
  it("collapses to one implicit pool of every account", () => {
    const pools = resolvePools(members("a", "b"), cfg())
    assert.equal(pools.length, 1)
    assert.deepEqual(pools[0]!.accounts, ["a", "b"])
  })

  it("uses flat accounts as the implicit pool, in order", () => {
    const pools = resolvePools(
      members("a", "b", "c"),
      cfg({ accounts: ["c", "a"] }),
    )
    assert.deepEqual(pools[0]!.accounts, ["c", "a"])
  })

  it("drops configured accounts that no longer exist", () => {
    const pools = resolvePools(
      members("a"),
      cfg({ pools: [{ name: "p", accounts: ["a", "ghost"] }] }),
    )
    assert.deepEqual(pools[0]!.accounts, ["a"])
  })

  it("drops a pool left empty by a stale config", () => {
    const pools = resolvePools(
      members("a"),
      cfg({
        pools: [
          { name: "dead", accounts: ["ghost"] },
          { name: "live", accounts: ["a"] },
        ],
      }),
    )
    assert.deepEqual(
      pools.map((p) => p.name),
      ["live"],
    )
  })
})

describe("strategies", () => {
  const cache: QuotaCache = {
    a: reading(0.8),
    b: reading(0.2),
    c: reading(0.5),
  }

  it("sticky keeps a healthy active account even when fuller", () => {
    const d = selectAccount(members("a", "b", "c"), cache, cfg(), "a", NOW_MS)
    assert.equal(d!.source, "a")
    assert.equal(d!.changed, false)
  })

  it("sticky moves to the emptiest once the active one is spent", () => {
    const spent: QuotaCache = { ...cache, a: reading(0.99) }
    const d = selectAccount(members("a", "b", "c"), spent, cfg(), "a", NOW_MS)
    assert.equal(d!.source, "b")
    assert.equal(d!.changed, true)
  })

  it("least-loaded picks the most headroom regardless of who is active", () => {
    const d = selectAccount(
      members("a", "b", "c"),
      cache,
      cfg({ strategy: "least-loaded" }),
      "a",
      NOW_MS,
    )
    assert.equal(d!.source, "b")
  })

  it("least-loaded ranks an unmeasured account behind a measured one", () => {
    const d = selectAccount(
      members("a", "unknown"),
      { a: reading(0.8) },
      cfg({ strategy: "least-loaded" }),
      null,
      NOW_MS,
    )
    assert.equal(d!.source, "a")
  })

  it("priority follows config order, not headroom", () => {
    const d = selectAccount(
      members("a", "b", "c"),
      cache,
      cfg({ strategy: "priority", accounts: ["c", "b", "a"] }),
      null,
      NOW_MS,
    )
    assert.equal(d!.source, "c")
  })

  it("round-robin rotates across successive decisions", () => {
    const c = cfg({ strategy: "round-robin", accounts: ["a", "b", "c"] })
    const picks = [0, 1, 2, 3].map(
      () =>
        selectAccount(members("a", "b", "c"), cache, c, null, NOW_MS)!.source,
    )
    assert.deepEqual(picks, ["a", "b", "c", "a"])
  })

  it("round-robin skips a spent member", () => {
    const spent: QuotaCache = { ...cache, b: reading(1.0) }
    const c = cfg({ strategy: "round-robin", accounts: ["a", "b", "c"] })
    const picks = [0, 1, 2].map(
      () =>
        selectAccount(members("a", "b", "c"), spent, c, null, NOW_MS)!.source,
    )
    assert.deepEqual(picks, ["a", "c", "a"])
  })

  it("weighted interleaves a 2:1 split rather than bursting", () => {
    const c = cfg({
      strategy: "weighted",
      pools: [{ name: "p", accounts: ["a", "b"], weights: { a: 2, b: 1 } }],
    })
    const picks = [0, 1, 2].map(
      () => selectAccount(members("a", "b"), cache, c, null, NOW_MS)!.source,
    )
    // Smooth weighted round-robin: a, then b, then a — not a, a, b.
    assert.deepEqual(picks, ["a", "b", "a"])
    assert.equal(picks.filter((p) => p === "a").length, 2)
  })
})

describe("tiered failover", () => {
  const pools = [
    { name: "primary", accounts: ["a", "b"] },
    { name: "fallback", accounts: ["z"] },
  ]

  it("stays in the primary tier while it has room", () => {
    const cache: QuotaCache = {
      a: reading(0.5),
      b: reading(0.6),
      z: reading(0.0),
    }
    const d = selectAccount(
      members("a", "b", "z"),
      cache,
      cfg({ pools }),
      null,
      NOW_MS,
    )
    assert.equal(d!.pool, "primary")
  })

  it("reaches the fallback only when the primary is fully spent", () => {
    const cache: QuotaCache = {
      a: reading(1.0),
      b: reading(1.0),
      z: reading(0.1),
    }
    const d = selectAccount(
      members("a", "b", "z"),
      cache,
      cfg({ pools }),
      null,
      NOW_MS,
    )
    assert.equal(d!.pool, "fallback")
    assert.equal(d!.source, "z")
  })

  it("when everything is spent, picks whoever resets soonest and says so", () => {
    const cache: QuotaCache = {
      a: reading(1.0, { resetsIn: 7200 }),
      b: reading(1.0, { resetsIn: 600 }),
      z: reading(1.0, { resetsIn: 3600 }),
    }
    const d = selectAccount(
      members("a", "b", "z"),
      cache,
      cfg({ pools }),
      null,
      NOW_MS,
    )
    assert.equal(d!.source, "b")
    assert.equal(d!.pool, "exhausted")
    assert.match(d!.reason, /all accounts spent/)
  })

  it("returns nothing when there are no accounts at all", () => {
    assert.equal(selectAccount([], {}, cfg(), null, NOW_MS), undefined)
  })
})

describe("usage-driven and randomised strategies", () => {
  const cache: QuotaCache = {
    a: reading(0.8),
    b: reading(0.2),
    c: reading(0.5),
  }

  it("least-used picks the account that has served least", () => {
    const d = selectAccount(
      members("a", "b", "c"),
      cache,
      cfg({ strategy: "least-used" }),
      "a",
      NOW_MS,
      {
        usage: {
          a: { requests: 9, lastUsedAt: 3 },
          b: { requests: 7, lastUsedAt: 2 },
          c: { requests: 2, lastUsedAt: 1 },
        },
      },
    )
    // c, even though b has more quota headroom.
    assert.equal(d!.source, "c")
  })

  it("least-used breaks a tie on the older last-used", () => {
    const d = selectAccount(
      members("a", "b"),
      cache,
      cfg({ strategy: "least-used" }),
      null,
      NOW_MS,
      {
        usage: {
          a: { requests: 5, lastUsedAt: 900 },
          b: { requests: 5, lastUsedAt: 100 },
        },
      },
    )
    assert.equal(d!.source, "b")
  })

  it("least-used falls back to least-loaded with no history", () => {
    const d = selectAccount(
      members("a", "b", "c"),
      cache,
      cfg({ strategy: "least-used" }),
      "a",
      NOW_MS,
      { usage: {} },
    )
    assert.equal(d!.source, "b")
  })

  it("random honours the injected generator", () => {
    const pick = (r: number) =>
      selectAccount(
        members("a", "b", "c"),
        cache,
        cfg({ strategy: "random", accounts: ["a", "b", "c"] }),
        null,
        NOW_MS,
        { rng: () => r },
      )!.source
    assert.equal(pick(0), "a")
    assert.equal(pick(0.5), "b")
    assert.equal(pick(0.99), "c")
  })

  it("p2c samples two and keeps the emptier", () => {
    // First draw picks index 0 (a, 80%), second picks index 2 (c, 50%) -> c wins.
    const draws = [0, 0.7]
    let i = 0
    const d = selectAccount(
      members("a", "b", "c"),
      cache,
      cfg({ strategy: "p2c", accounts: ["a", "b", "c"] }),
      null,
      NOW_MS,
      { rng: () => draws[i++ % draws.length]! },
    )
    assert.equal(d!.source, "c")
  })

  it("p2c on a single candidate returns it without sampling", () => {
    const d = selectAccount(
      members("a"),
      { a: reading(0.1) },
      cfg({ strategy: "p2c" }),
      null,
      NOW_MS,
      {
        rng: () => {
          throw new Error("must not be called")
        },
      },
    )
    assert.equal(d!.source, "a")
  })
})

describe("account references", () => {
  it("resolves a label fragment as well as an exact source", () => {
    const live: Member[] = [
      {
        source: "Claude Code-credentials-aaaa1111",
        label: "Claude Team - Team A",
      },
      {
        source: "Claude Code-credentials-bbbb2222",
        label: "Claude Team - Team B",
      },
    ]
    assert.equal(resolveRef("Team B", live), "Claude Code-credentials-bbbb2222")
    assert.equal(
      resolveRef("Claude Code-credentials-aaaa1111", live),
      "Claude Code-credentials-aaaa1111",
    )
    assert.equal(resolveRef("team a", live), "Claude Code-credentials-aaaa1111")
  })

  it("refuses an ambiguous fragment rather than guessing", () => {
    const live: Member[] = [
      { source: "s1", label: "Claude Team - Team A" },
      { source: "s2", label: "Claude Team - Team B" },
    ]
    assert.equal(resolveRef("Claude Team", live), undefined)
  })

  it("matches an exact id before source or label", () => {
    const live: Member[] = [
      { source: "s1", id: "acme-1", label: "Team A" },
      { source: "s2", id: "acme-2", label: "Team B" },
    ]
    assert.equal(resolveRef("acme-2", live), "s2")
    // Source and label forms still resolve for one release.
    assert.equal(resolveRef("s1", live), "s1")
    assert.equal(resolveRef("Team B", live), "s2")
  })

  it("reports references that went nowhere", () => {
    const live: Member[] = [{ source: "s1", label: "Team A" }]
    const { sources, unresolved } = resolveAccountRefs(
      ["Team A", "Team Z"],
      live,
    )
    assert.deepEqual(sources, ["s1"])
    assert.deepEqual(unresolved, ["Team Z"])
  })

  it("expands a group name to its accounts, in group order", () => {
    const groups = { groupA: { accounts: ["b", "a"] } }
    assert.deepEqual(
      resolvePools(
        members("a", "b", "c"),
        cfg({ accounts: ["groupA"], groups }),
      )[0]!.accounts,
      ["b", "a"],
    )
    const pools = resolvePools(
      members("a", "b", "c"),
      cfg({ pools: [{ name: "p", accounts: ["c", "groupA"] }], groups }),
    )
    assert.deepEqual(pools[0]!.accounts, ["c", "b", "a"])
  })

  it("orders members by config, groups expanded, the rest after", () => {
    const out = orderByConfig(members("a", "b", "c", "d"), ["G", "a"], {
      G: { accounts: ["c", "b"] },
    })
    assert.deepEqual(
      out.map((m) => m.source),
      ["c", "b", "a", "d"],
    )
  })

  it("routes a preset naming a group to the group's members", () => {
    const groups = { groupA: { accounts: ["b", "c"] } }
    const presets = { p: { accounts: ["groupA", "nosuchgroup"] } }
    const active = resolveActiveConfig(
      cfg({ groups, presets, preset: "p" }),
      null,
    )
    assert.deepEqual(
      resolvePools(members("a", "b", "c"), active.cfg)[0]!.accounts,
      ["b", "c"],
    )
    assert.deepEqual(
      resolveAccountRefs(
        ["groupA", "nosuchgroup"],
        members("a", "b", "c"),
        groups,
      ).unresolved,
      ["nosuchgroup"],
    )
  })

  it("lets a pool name accounts by label", () => {
    const live: Member[] = [
      { source: "s1", label: "Team A" },
      { source: "s2", label: "Team B" },
    ]
    const pools = resolvePools(
      live,
      cfg({ pools: [{ name: "p", accounts: ["Team B"] }] }),
    )
    assert.deepEqual(pools[0]!.accounts, ["s2"])
  })
})

describe("ejection honours the server's retry-after", () => {
  it("uses retry-after when it is longer than the backoff", () => {
    const e = eject("a", cfg({ ejectFor: 1000 }), NOW_MS, 30_000)
    assert.equal(e.until, NOW_MS + 30_000)
  })

  it("keeps the backoff when retry-after is shorter", () => {
    // A repeatedly failing account must not be retried every few seconds just
    // because it keeps asking to be.
    eject("a", cfg({ ejectFor: 10_000 }), NOW_MS)
    const second = eject("a", cfg({ ejectFor: 10_000 }), NOW_MS, 1000)
    assert.equal(second.until, NOW_MS + 20_000)
  })

  it("ignores a nonsensical retry-after", () => {
    const e = eject("a", cfg({ ejectFor: 5000 }), NOW_MS, 0)
    assert.equal(e.until, NOW_MS + 5000)
  })
})

describe("over threshold is not the same as exhausted", () => {
  // switchAt is a margin, not the limit. Three accounts sitting at 96-98% with
  // the server still answering `allowed` will serve requests perfectly well;
  // announcing "all accounts spent, wait 53m" while they idle was the bug.
  it("uses the emptiest still-serving account instead of declaring exhaustion", () => {
    const cache: QuotaCache = {
      a: reading(0.98),
      b: reading(0.96),
      c: reading(0.97),
    }
    const d = selectAccount(
      members("a", "b", "c"),
      cache,
      cfg({ switchAt: 0.95 }),
      null,
      NOW_MS,
    )
    assert.equal(d!.pool, "over-threshold")
    assert.equal(d!.source, "b", "the emptiest of the three")
    assert.match(d!.reason, /above switchAt/)
  })

  it("still declares exhaustion when the server actually refused them", () => {
    const cache: QuotaCache = {
      a: reading(1.0, { status: "rejected" }),
      b: reading(1.0, { status: "rejected" }),
    }
    const d = selectAccount(members("a", "b"), cache, cfg(), null, NOW_MS)
    assert.equal(d!.pool, "exhausted")
  })

  it("does not fall back to an account at its literal limit", () => {
    const cache: QuotaCache = { a: reading(1.0), b: reading(1.01) }
    const d = selectAccount(members("a", "b"), cache, cfg(), null, NOW_MS)
    assert.equal(d!.pool, "exhausted")
  })

  it("does not fall back to an ejected account", () => {
    const cache: QuotaCache = { a: reading(0.97), b: reading(0.98) }
    eject("a", cfg({ ejectFor: 60_000 }), NOW_MS)
    eject("b", cfg({ ejectFor: 60_000 }), NOW_MS)
    const d = selectAccount(members("a", "b"), cache, cfg(), null, NOW_MS)
    assert.equal(d!.pool, "exhausted")
  })

  it("does not fall back to an account that cannot authenticate", () => {
    const cache: QuotaCache = { dead: reading(0.5) }
    const d = selectAccount(
      [{ source: "dead", credential: "unusable" }],
      cache,
      cfg(),
      null,
      NOW_MS,
    )
    assert.equal(d!.pool, "exhausted")
  })

  it("prefers a healthy account over a merely-serving one", () => {
    // The degraded path must never win while something is genuinely under the bar.
    const cache: QuotaCache = { full: reading(0.98), ok: reading(0.1) }
    const d = selectAccount(members("full", "ok"), cache, cfg(), null, NOW_MS)
    assert.equal(d!.source, "ok")
    assert.notEqual(d!.pool, "over-threshold")
  })
})

const WEIGHTED_MEMBERS = [
  { source: "a", label: "A", utilization: 0 },
  { source: "b", label: "B", utilization: 0 },
]

describe("weights on the flat path", () => {
  const base = {
    pools: [],
    accounts: ["a", "b"],
    strategy: "weighted" as const,
  }

  it("carries configured weights into the synthesised pool", () => {
    // Without this the pool has no weights, every account weighs 1, and
    // `weighted` is round-robin wearing another name.
    const [pool] = resolvePools(WEIGHTED_MEMBERS, {
      ...base,
      weights: { a: 3, b: 1 },
    })
    assert.deepEqual(pool!.weights, { a: 3, b: 1 })
  })

  it("omits the field entirely when no weights are configured", () => {
    const [pool] = resolvePools(WEIGHTED_MEMBERS, { ...base, weights: {} })
    assert.equal(pool!.weights, undefined)
  })

  it("spreads requests in the configured ratio", () => {
    const pool = {
      name: "default",
      accounts: ["a", "b"],
      weights: { a: 3, b: 1 },
    }
    const picks: string[] = []
    for (let i = 0; i < 8; i++) {
      picks.push(
        STRATEGIES.weighted({
          candidates: WEIGHTED_MEMBERS,
          pool,
          activeSource: null,
          usage: {},
          rng: () => 0,
        } as never),
      )
    }
    const a = picks.filter((p) => p === "a").length
    assert.equal(a, 6, `3:1 over 8 picks should give a six times, got ${a}`)
    assert.equal(picks.filter((p) => p === "b").length, 2)
  })

  it("treats an unweighted account as weight 1, not zero", () => {
    // Weighing it 0 would exclude an account nobody excluded.
    resetCursors()
    const pool = {
      name: "wtest-default",
      accounts: ["a", "b"],
      weights: { a: 2 },
    }
    const picks: string[] = []
    for (let i = 0; i < 6; i++) {
      picks.push(
        STRATEGIES.weighted({
          candidates: WEIGHTED_MEMBERS,
          pool,
          activeSource: null,
          usage: {},
          rng: () => 0,
        } as never),
      )
    }
    assert.ok(picks.includes("b"), "the unweighted account never served")
    assert.equal(picks.filter((p) => p === "a").length, 4)
  })
})

describe("credits are a tier, not an equal", () => {
  // The live shape this exists for: an account reporting 5h at 100% with the
  // header saying "rejected", serving 315 requests with no failures because
  // paid overflow was covering it -- while the balancer announced that every
  // account was spent and told the operator to wait.
  const credits = (
    util: number,
    opts: { enabled?: boolean; capped?: boolean } = {},
  ) => ({
    ...reading(util, util >= 1 ? { status: "rejected" } : {}),
    extra: {
      enabled: opts.enabled ?? true,
      capReached: opts.capped ?? false,
      usedMinor: 11378,
      limitMinor: 20000,
      currency: "EUR",
    },
  })

  it("uses a credit-covered account instead of declaring exhaustion", () => {
    const cache: QuotaCache = { a: credits(1.0), b: credits(1.01) }
    const d = selectAccount(members("a", "b"), cache, cfg(), null, NOW_MS)
    assert.equal(d!.pool, "credits")
    assert.match(d!.reason, /using credits/)
  })

  it("still declares exhaustion once the credit cap is reached", () => {
    const cache: QuotaCache = {
      a: credits(1.0, { capped: true }),
      b: credits(1.01, { capped: true }),
    }
    const d = selectAccount(members("a", "b"), cache, cfg(), null, NOW_MS)
    assert.equal(d!.pool, "exhausted")
    assert.match(d!.reason, /credits exhausted or unavailable/)
  })

  it("still declares exhaustion when credits are switched off", () => {
    const cache: QuotaCache = {
      a: credits(1.0, { enabled: false }),
      b: credits(1.01, { enabled: false }),
    }
    assert.equal(
      selectAccount(members("a", "b"), cache, cfg(), null, NOW_MS)!.pool,
      "exhausted",
    )
  })

  it("prefers free headroom over paid, however thin the free margin", () => {
    // Spending money while an account still has its own allowance is buying
    // what is already paid for.
    const cache: QuotaCache = { a: credits(1.0), b: reading(0.99) }
    const d = selectAccount(
      members("a", "b"),
      cache,
      cfg({ switchAt: 0.95 }),
      null,
      NOW_MS,
    )
    assert.equal(d!.pool, "over-threshold")
    assert.equal(d!.source, "b")
  })

  it("does not call an account paid while it is still inside its allowance", () => {
    // Credits enabled is not credits spent: at 97% this account owes nothing.
    const cache: QuotaCache = { a: credits(0.97) }
    const h = assess(members("a"), cache, cfg({ switchAt: 0.95 }), NOW_MS)[0]
    assert.equal(h!.paidCapacity, false)
  })

  it("does not fall back to an ejected account just because it has credits", () => {
    const cache: QuotaCache = { a: credits(1.0) }
    eject("a", cfg({ ejectFor: 60_000 }), NOW_MS)
    assert.equal(
      selectAccount(members("a"), cache, cfg(), null, NOW_MS)!.pool,
      "exhausted",
    )
  })
})

describe("declining paid overflow", () => {
  const paid = (u: number) => ({
    ...reading(u, u >= 1 ? { status: "rejected" } : {}),
    extra: {
      enabled: true,
      capReached: false,
      usedMinor: 100,
      limitMinor: 20000,
    },
  })

  it("stops rather than bills when credits are switched off", () => {
    const cache: QuotaCache = { a: paid(1.0), b: paid(1.01) }
    const on = selectAccount(members("a", "b"), cache, cfg(), null, NOW_MS)
    const off = selectAccount(
      members("a", "b"),
      cache,
      cfg({ useCredits: false }),
      null,
      NOW_MS,
    )
    assert.equal(on!.pool, "credits")
    assert.equal(off!.pool, "exhausted")
  })

  it("still uses free capacity when credits are off", () => {
    // Declining to spend is not declining to work.
    const cache: QuotaCache = { a: paid(1.0), b: reading(0.4) }
    const d = selectAccount(
      members("a", "b"),
      cache,
      cfg({ useCredits: false }),
      null,
      NOW_MS,
    )
    assert.equal(d!.source, "b")
    assert.notEqual(d!.pool, "exhausted")
  })
})

// Regression: presets migrated to ids showed every account as "[?] matches no
// account", because callers build members from the Keychain without ids.
describe("resolveRef with registered ids", () => {
  const bare: Member[] = [
    { source: "src-1", label: "Claude Team - Acme 1" },
    { source: "src-2", label: "Claude Team - Acme 2" },
  ]
  const ids = (id: string) =>
    ({ "acme-1": "src-1", "acme-2": "src-2", gone: "src-9" })[id]

  it("resolves an id through the registry when members carry none", () => {
    assert.equal(resolveRef("acme-2", bare, ids), "src-2")
    assert.equal(
      resolveRef("acme-2", bare, () => undefined),
      undefined,
      "without the registry lookup it is unresolved",
    )
  })

  it("ignores an id whose account is not a member", () => {
    assert.equal(resolveRef("gone", bare, ids), undefined)
  })

  it("still prefers an id carried on the member", () => {
    const withId = [{ ...bare[0]!, id: "acme-2" }, bare[1]!]
    assert.equal(resolveRef("acme-2", withId, ids), "src-1")
  })
})

describe("recoveryTimes", () => {
  const win = (utilization: number, resetsIn: number, status?: string) => ({
    utilization,
    resetsAt: NOW_SEC + resetsIn,
    ...(status ? { status } : {}),
  })
  it("waits for every blocking window, soonest account first", () => {
    const cache = {
      a: {
        fiveHour: win(1, 600, "rejected"),
        sevenDay: win(0.2, 86400),
        observedAt: NOW_SEC,
      },
      b: {
        fiveHour: win(0.1, 300),
        sevenDay: win(1, 7200),
        observedAt: NOW_SEC,
      },
      c: { fiveHour: win(1, 60), sevenDay: win(1, 3600), observedAt: NOW_SEC },
    }
    const r = recoveryTimes(
      members("a", "b", "c"),
      cache as never,
      cfg(),
      NOW_MS,
    )
    assert.deepEqual(
      r.map((x) => [x.source, (x.at - NOW_MS) / 1000]),
      [
        ["a", 600],
        ["c", 3600],
        ["b", 7200],
      ],
    )
  })
  it("leaves out unusable credentials and accounts already free", () => {
    const cache = {
      a: { fiveHour: win(1, 600), observedAt: NOW_SEC },
      b: { fiveHour: win(0.2, 600), observedAt: NOW_SEC },
    }
    const ms = [
      { source: "a", credential: "unusable" as const },
      { source: "b" },
    ]
    assert.deepEqual(recoveryTimes(ms, cache as never, cfg(), NOW_MS), [])
  })
})

describe("spentRetry", () => {
  const clock = (ms: number) => `T+${Math.round((ms - NOW_MS) / 60000)}m`
  // Regression: a fixed 60s retry-after ran out OpenCode's 10 retries after
  // ~10 minutes, so a request failed long before any account was back.
  it("paces retries so OpenCode's ten attempts reach the reset", () => {
    const r = spentRetry(
      { name: "Alt 2", at: NOW_MS + 7020_000 },
      NOW_MS,
      clock,
    )
    assert.equal(r.retryAfterS, 780)
    assert.ok(r.retryAfterS * 9 >= 7020)
    assert.match(r.message, /Re-checking every 13m/)
  })
  it("never re-checks more often than a minute or less than every 15 minutes", () => {
    assert.equal(
      spentRetry({ name: "a", at: NOW_MS + 300_000 }, NOW_MS, clock)
        .retryAfterS,
      60,
    )
    assert.equal(
      spentRetry({ name: "a", at: NOW_MS + 86_400_000 }, NOW_MS, clock)
        .retryAfterS,
      900,
    )
  })
  it("names the next account and its real wait", () => {
    const r = spentRetry(
      { name: "Alt 2", at: NOW_MS + 7020_000 },
      NOW_MS,
      clock,
      896,
    )
    assert.equal(r.retryAfterS, 780)
    assert.match(r.message, /Next back: Alt 2 at T\+117m \(in 1h57m\)/)
  })
  it("retries at the reset when it is sooner than the re-check", () => {
    assert.equal(
      spentRetry({ name: "a", at: NOW_MS + 20_000 }, NOW_MS, clock).retryAfterS,
      20,
    )
  })
  it("still re-checks when no reset is known", () => {
    const r = spentRetry(undefined, NOW_MS, clock)
    assert.equal(r.retryAfterS, 60)
    assert.match(r.message, /no reset time is known/)
  })
})

// Regression: least-used read usage by Keychain source while new rows are
// keyed by account id, so a busy migrated account looked unused.
describe("usageOf", () => {
  it("sums the id and the pre-migration source key", () => {
    const usage = {
      "acme-1": { requests: 5, lastUsedAt: 20 },
      "src-1": { requests: 2, lastUsedAt: 10 },
    }
    const keyOf = (s: string) => (s === "src-1" ? "acme-1" : s)
    assert.deepEqual(usageOf(usage, "src-1", keyOf), {
      requests: 7,
      lastUsedAt: 20,
    })
    assert.deepEqual(usageOf(usage, "src-9", keyOf), {
      requests: 0,
      lastUsedAt: 0,
    })
  })
})
