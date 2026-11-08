/**
 * Which account should serve the next request.
 *
 * Everything here is a pure function of (members, quota cache, config, now)
 * plus one explicit ejection map, so the whole policy is testable without a
 * Keychain, a network, or a clock. `index.ts` owns the side effects: it reads
 * the config fresh at each decision — which is what keeps the strategy and the
 * pools hot-reloadable — and calls `setActiveAccountSource()` with the answer.
 *
 * Health is *derived*, not stored. An account is spent when the quota cache
 * says so, and it becomes healthy again when the window's own `resetsAt`
 * passes. Anthropic hands us that timestamp, so there is nothing to persist
 * and nothing to expire by guesswork. The one exception is a rejection that
 * arrives without a usable reset time; that gets a bounded, backing-off entry
 * in the ejection map, which is per-process and deliberately not written to
 * disk (see `ejections` below).
 */

import type {
  AccountGroup,
  BalanceStrategy,
  ClaudeAuthConfig,
  Pool,
  SwitchWindow,
} from "../config.ts"
import { getConfig } from "../config.ts"
import { sourceForId } from "./accounts-id.ts"
import { ceilingFor } from "./caps.ts"
import { readIdentityCacheFresh } from "./identity.ts"
import { accountKey } from "./account-key.ts"
import {
  type AccountQuota,
  type QuotaCache,
  type QuotaWindow,
  bindingWindow,
  creditHeadroom,
  formatDuration,
  quotaForAccount,
} from "./quota.ts"

/**
 * Whether an account's stored credentials can serve a request.
 *
 * Quota is not the only way an account can be unusable: one can hold plenty of
 * headroom and still have a token that expired days ago. `refreshable` is a
 * candidate rather than a fault — the credential path recovers those — but it is
 * ranked behind an account that needs no recovery at all.
 */
export type CredentialState = "ok" | "refreshable" | "unusable"

export type Member = {
  source: string
  label?: string
  /** Stable account id, when one is registered for this account. */
  id?: string
  credential?: CredentialState
}

export type Health = {
  source: string
  /** Utilisation on the configured window, or undefined when unknown. */
  utilization?: number
  /** Unix seconds the binding window resets, when known. */
  resetsAt?: number
  credential: CredentialState
  healthy: boolean
  /** Why it is unhealthy, for the log. "" when healthy. */
  reason: string
  /**
   * The included allowance is gone and credits are covering it: still serving,
   * for money. Distinct from `healthy`, which stays false -- this account is a
   * last resort, not an equal.
   */
  paidCapacity?: boolean
  /**
   * At or above its configured `maxUsage` ceiling on some window: held in
   * reserve. Unhealthy, but a rank above a genuinely spent account -- it has
   * free allowance left, deliberately withheld, which a soft mode or a session
   * override can release.
   */
  reserved?: boolean
  /** How far past the ceiling it is (margin), for ranking the emptiest reserve. */
  reservedMargin?: number
}

// ---------------------------------------------------------------------------
// Ejection: only for rejections we cannot date from a header
// ---------------------------------------------------------------------------

type Ejection = { until: number; count: number }

/**
 * Per-process, in-memory, and intentionally so.
 *
 * Two OpenCode windows share a Keychain and a quota cache but must be free to
 * sit on different accounts — that is the point of balancing. Persisting an
 * ejection would let one process's 429 move another process's account, which
 * is the same class of cross-process interference the per-account refresh lock
 * exists to prevent.
 */
const ejections = new Map<string, Ejection>()

/** Eject `source` for `ejectFor` x consecutive ejections, capped at an hour. */
export function eject(
  source: string,
  cfg: Pick<ClaudeAuthConfig, "ejectFor">,
  nowMs: number = Date.now(),
  /**
   * The server's own `retry-after`, when it sent one. Preferred over the backoff
   * because it states when traffic will be accepted again instead of guessing —
   * but still floored by the backoff, so a repeatedly failing account is not
   * retried every few seconds because it keeps asking to be.
   */
  retryAfterMs?: number,
): Ejection {
  const prev = ejections.get(source)
  const count = (prev?.count ?? 0) + 1
  const base = cfg.ejectFor > 0 ? cfg.ejectFor : 0
  const backoff = Math.min(base * count, 60 * 60_000)
  const until = nowMs + Math.max(backoff, retryAfterMs ?? 0)
  const next = { until, count }
  ejections.set(source, next)
  return next
}

/** Called when an account serves a request successfully. */
export function clearEjection(source: string): void {
  ejections.delete(source)
}

export function ejectedUntil(
  source: string,
  nowMs: number = Date.now(),
): number | undefined {
  const e = ejections.get(source)
  if (!e) return undefined
  if (e.until <= nowMs) {
    // Expired entries are dropped on read so the backoff count only survives
    // while the account keeps failing, not forever.
    ejections.delete(source)
    return undefined
  }
  return e.until
}

/** Test seam. */
export function resetEjections(): void {
  ejections.clear()
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export function windowFor(
  q: AccountQuota,
  which: SwitchWindow,
): QuotaWindow | undefined {
  if (which === "5h") return q.fiveHour
  if (which === "7d") return q.sevenDay
  return bindingWindow(q)
}

/**
 * A window that has already reset is spent no longer: `resetsAt` in the past
 * means the utilisation figure describes a window that no longer exists.
 */
function effectiveUtilization(
  w: QuotaWindow | undefined,
  nowSec: number,
): number | undefined {
  if (!w) return undefined
  if (w.resetsAt !== undefined && w.resetsAt <= nowSec) return 0
  return w.utilization
}

export function assess(
  members: readonly Member[],
  cache: QuotaCache,
  cfg: Pick<
    ClaudeAuthConfig,
    "switchAt" | "switchWindow" | "quotaMaxAge" | "accountIds"
  >,
  nowMs: number = Date.now(),
): Health[] {
  const nowSec = Math.floor(nowMs / 1000)
  const maxAgeSeconds = Math.floor((cfg.quotaMaxAge ?? 0) / 1000) || undefined

  /**
   * How far past its ceiling an account is on its worst window, or undefined
   * when under every ceiling. Checks BOTH windows regardless of switchWindow:
   * a weekly ceiling reserves an account even while its 5h figure looks fine.
   */
  const reserveMargin = (m: Member, q: AccountQuota): number | undefined => {
    const id = m.id ?? m.source
    let worst: number | undefined
    for (const which of ["5h", "7d"] as const) {
      const w = which === "5h" ? q.fiveHour : q.sevenDay
      const util = effectiveUtilization(w, nowSec)
      if (util === undefined) continue
      const ceiling = ceilingFor(cfg, id, which)
      if (ceiling >= 1) continue
      if (util >= ceiling) {
        const margin = util - ceiling
        if (worst === undefined || margin > worst) worst = margin
      }
    }
    return worst
  }

  return members.map((m) => {
    const credential = m.credential ?? "ok"

    // Headroom is irrelevant if the account cannot authenticate at all.
    if (credential === "unusable") {
      return {
        source: m.source,
        credential,
        healthy: false,
        reason: "credentials expired and cannot be refreshed",
      }
    }

    const held = ejectedUntil(m.source, nowMs)
    if (held !== undefined) {
      return {
        source: m.source,
        credential,
        healthy: false,
        reason: `ejected for ${Math.ceil((held - nowMs) / 1000)}s`,
      }
    }

    const q = quotaForAccount(m.source, cache, nowSec, maxAgeSeconds)
    // Paid overflow, which no rate-limit header mentions. Without it a spent
    // account looks dead while it is still answering every request -- and
    // without the headroom check, an account whose credits are already gone
    // looks alive while it refuses them.
    const credits = creditHeadroom(q?.extra)
    if (!q) {
      // No reading is not a fault. An unprobed account is assumed usable —
      // refusing it would strand a fresh install where nothing has been
      // measured yet — but `least-loaded` still ranks it behind any account
      // whose headroom is actually known.
      return { source: m.source, credential, healthy: true, reason: "" }
    }

    const w = windowFor(q, cfg.switchWindow)
    const util = effectiveUtilization(w, nowSec)
    const margin = reserveMargin(m, q)

    if (w?.status === "rejected" && (w.resetsAt ?? 0) > nowSec) {
      return {
        source: m.source,
        utilization: util,
        resetsAt: w.resetsAt,
        credential,
        healthy: false,
        reason: "server rejected",
        paidCapacity: credits,
      }
    }
    if (util !== undefined && util >= cfg.switchAt) {
      return {
        source: m.source,
        utilization: util,
        resetsAt: w?.resetsAt,
        credential,
        healthy: false,
        reason: `at ${Math.round(util * 100)}% of ${cfg.switchWindow}`,
        // Only once the allowance is actually gone. Between switchAt and the
        // limit the account is still free, and spending money there would be
        // buying what it already has.
        paidCapacity: credits && util >= 1,
        ...(margin !== undefined
          ? { reserved: true, reservedMargin: margin }
          : {}),
      }
    }

    // Under switchAt, but past a configured ceiling on some window: reserved.
    // Free allowance remains, held back deliberately -- a rank above spent.
    if (margin !== undefined) {
      const worst = reservedWindowPercent(m, q, cfg, nowSec)
      return {
        source: m.source,
        utilization: util,
        resetsAt: w?.resetsAt,
        credential,
        healthy: false,
        reason: `reserved: at ${worst.percent}% of ${worst.window} (ceiling ${worst.ceiling}%)`,
        reserved: true,
        reservedMargin: margin,
      }
    }

    return {
      source: m.source,
      utilization: util,
      resetsAt: w?.resetsAt,
      credential,
      healthy: true,
      reason: "",
    }
  })
}

/**
 * The window whose ceiling an account has most exceeded, with the figures the
 * reason line quotes. Only called when `reserveMargin` already found a breach,
 * so it always finds one.
 */
function reservedWindowPercent(
  m: Member,
  q: AccountQuota,
  cfg: Pick<ClaudeAuthConfig, "accountIds">,
  nowSec: number,
): { window: "5h" | "7d"; percent: number; ceiling: number } {
  const id = m.id ?? m.source
  let best = {
    window: "5h" as "5h" | "7d",
    percent: 0,
    ceiling: 100,
    margin: -1,
  }
  for (const which of ["5h", "7d"] as const) {
    const w = which === "5h" ? q.fiveHour : q.sevenDay
    const util = effectiveUtilization(w, nowSec)
    if (util === undefined) continue
    const ceiling = ceilingFor(cfg, id, which)
    if (ceiling >= 1 || util < ceiling) continue
    const margin = util - ceiling
    if (margin > best.margin) {
      best = {
        window: which,
        percent: Math.round(util * 100),
        ceiling: Math.round(ceiling * 100),
        margin,
      }
    }
  }
  return { window: best.window, percent: best.percent, ceiling: best.ceiling }
}

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

/**
 * The configured tiers, narrowed to accounts that actually exist.
 *
 * With no pools declared, everything collapses to a single implicit tier —
 * `accounts` when set, otherwise every member — so the common one-tier setup
 * needs no pool config at all. A configured account that matches nothing live
 * is dropped rather than honoured, and a pool left empty by that is dropped
 * too: a stale config must not be able to strand the plugin on no account.
 */
/**
 * Turn one account reference into a live Keychain source.
 *
 * A reference is, in precedence order: an exact account id (`acme-1`), an exact
 * source (`Claude Code-credentials-aaaa1111`), or a case-insensitive fragment of
 * the account's label (`Team B`). Ids come first and win outright -- that is the
 * stable form migration rewrites everything to. The source and label forms are
 * kept for one release so an un-migrated config still resolves.
 *
 * A fragment matching more than one account returns undefined rather than
 * guessing: silently picking one of two plausible accounts is worse than saying
 * the reference was no good.
 */
/** The Keychain source a registered account id points at, from config + identity cache. */
export function liveIdToSource(id: string): string | undefined {
  try {
    const registry = getConfig().accountIds
    return registry[id]
      ? sourceForId(id, readIdentityCacheFresh(), registry)
      : undefined
  } catch {
    return undefined
  }
}

export function resolveRef(
  ref: string,
  members: readonly Member[],
  idToSource: (id: string) => string | undefined = liveIdToSource,
): string | undefined {
  const byId = members.find((m) => m.id === ref)
  if (byId) return byId.source

  // Most callers build members from the Keychain without ids; a registered id
  // must still resolve, or every migrated preset reference goes nowhere.
  const viaRegistry = idToSource(ref)
  if (viaRegistry && members.some((m) => m.source === viaRegistry))
    return viaRegistry

  const exact = members.find((m) => m.source === ref)
  if (exact) return exact.source

  const needle = ref.trim().toLowerCase()
  if (!needle) return undefined
  const hits = members.filter((m) => m.label?.toLowerCase().includes(needle))
  return hits.length === 1 ? hits[0]!.source : undefined
}

/**
 * A reference equal to a group name stands for that group's accounts, in
 * order; groups do not nest. Every other reference passes through.
 */
export function expandGroupRefs(
  refs: readonly string[],
  groups: Readonly<Record<string, AccountGroup>> = {},
): string[] {
  return refs.flatMap((r) =>
    Object.hasOwn(groups, r) ? groups[r]!.accounts : [r],
  )
}

/** Resolve a list of references (group names expanded), reporting the ones that went nowhere. */
export function resolveAccountRefs(
  refs: readonly string[],
  members: readonly Member[],
  groups: Readonly<Record<string, AccountGroup>> = {},
): { sources: string[]; unresolved: string[] } {
  const sources: string[] = []
  const unresolved: string[] = []
  for (const ref of expandGroupRefs(refs, groups)) {
    const source = resolveRef(ref, members)
    if (!source) unresolved.push(ref)
    else if (!sources.includes(source)) sources.push(source)
  }
  return { sources, unresolved }
}

/** Members in configured `accounts` order (group names expanded), then the rest in their own order. */
export function orderByConfig<M extends Member>(
  members: readonly M[],
  refs: readonly string[],
  groups: Readonly<Record<string, AccountGroup>> = {},
): M[] {
  const first = resolveAccountRefs(refs, members, groups).sources
  return [
    ...first.map((s) => members.find((m) => m.source === s)!),
    ...members.filter((m) => !first.includes(m.source)),
  ]
}

export function resolvePools(
  members: readonly Member[],
  cfg: Pick<ClaudeAuthConfig, "pools" | "accounts" | "strategy" | "weights"> &
    Partial<Pick<ClaudeAuthConfig, "groups">>,
): Pool[] {
  const keep = (refs: string[]) =>
    resolveAccountRefs(refs, members, cfg.groups).sources

  if (cfg.pools.length > 0) {
    return cfg.pools
      .map((p) => ({ ...p, accounts: keep(p.accounts) }))
      .filter((p) => p.accounts.length > 0)
  }

  const flat =
    cfg.accounts.length > 0 ? keep(cfg.accounts) : members.map((m) => m.source)
  if (flat.length === 0) return []
  // Weights ride along, or `weighted` on the flat path silently degrades to
  // round-robin: every account weighs 1 and nothing says so.
  const weights = cfg.weights && Object.keys(cfg.weights).length > 0
  return [
    {
      name: "default",
      accounts: flat,
      ...(weights ? { weights: cfg.weights } : {}),
    },
  ]
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

export type StrategyInput = {
  /** Healthy candidates, in pool order. Never empty. */
  candidates: Health[]
  /** The account serving requests right now, if any. */
  activeSource: string | null
  pool: Pool
  /** Requests served per account, for `least-used`. Empty when unknown. */
  usage: Record<string, { requests: number; lastUsedAt: number }>
  /** Injected so the randomised strategies can be asserted in a test. */
  rng: () => number
}

export type StrategyFn = (input: StrategyInput) => string

/** Round-robin and weighted need a cursor; it is per-pool and per-process. */
const cursors = new Map<string, number>()
const swrrState = new Map<string, Map<string, number>>()

export function resetCursors(): void {
  cursors.clear()
  swrrState.clear()
}

/**
 * Preference order: a credential that works, then known headroom.
 *
 * An account needing a token refresh is usable but not free — it costs a round
 * trip and can still fail — so it loses to any account that is ready now, no
 * matter how much emptier it looks.
 */
function credentialRank(h: Health): number {
  return h.credential === "refreshable" ? 1 : 0
}

function byHeadroom(a: Health, b: Health): number {
  const byCredential = credentialRank(a) - credentialRank(b)
  if (byCredential !== 0) return byCredential
  const au = a.utilization
  const bu = b.utilization
  if (au === undefined && bu === undefined) return 0
  if (au === undefined) return 1
  if (bu === undefined) return -1
  return au - bu
}

const leastLoaded: StrategyFn = ({ candidates }) =>
  [...candidates].sort(byHeadroom)[0]!.source

const priority: StrategyFn = ({ candidates, pool }) => {
  const order = new Map(pool.accounts.map((s, i) => [s, i]))
  return [...candidates].sort(
    (a, b) => (order.get(a.source) ?? 0) - (order.get(b.source) ?? 0),
  )[0]!.source
}

/**
 * Keep the current account while it is healthy and in this pool.
 *
 * This is the default because Anthropic's prompt cache is per-account: moving
 * accounts starts the new one's cache cold, so the cheapest correct answer is
 * to stay put until the account is actually spent, then take the emptiest one.
 */
const sticky: StrategyFn = (input) => {
  const held = input.candidates.find((c) => c.source === input.activeSource)
  if (held) return held.source
  return leastLoaded(input)
}

const roundRobin: StrategyFn = ({ candidates, pool }) => {
  const key = pool.name
  const order = new Map(pool.accounts.map((s, i) => [s, i]))
  const ring = [...candidates].sort(
    (a, b) => (order.get(a.source) ?? 0) - (order.get(b.source) ?? 0),
  )
  const next = (cursors.get(key) ?? 0) % ring.length
  cursors.set(key, next + 1)
  return ring[next]!.source
}

/**
 * Smooth weighted round-robin (the nginx algorithm): each pass adds every
 * candidate's weight to its running score, the highest score serves, and that
 * winner pays the total weight back. Spreads a 3:1 split as ABABAB-style
 * interleaving rather than AAAB bursts, and is deterministic, so it can be
 * asserted in a test.
 */
const weighted: StrategyFn = ({ candidates, pool }) => {
  const key = pool.name
  let state = swrrState.get(key)
  if (!state) {
    state = new Map()
    swrrState.set(key, state)
  }

  const weightOf = (s: string) => pool.weights?.[s] ?? 1
  const total = candidates.reduce((sum, c) => sum + weightOf(c.source), 0)

  let best = candidates[0]!.source
  let bestScore = Number.NEGATIVE_INFINITY
  for (const c of candidates) {
    const score = (state.get(c.source) ?? 0) + weightOf(c.source)
    state.set(c.source, score)
    if (score > bestScore) {
      bestScore = score
      best = c.source
    }
  }
  state.set(best, (state.get(best) ?? 0) - total)
  return best
}

/**
 * Fewest requests served, per the usage log; oldest last-used breaks a tie.
 *
 * Where `least-loaded` reads Anthropic's view of consumption, this reads ours.
 * The two disagree usefully: utilisation is weighted by how expensive the
 * requests were, request count is not, so this spreads *turns* evenly while
 * `least-loaded` spreads *spend*. With no usage history it degrades to
 * `least-loaded` rather than picking arbitrarily.
 */
/**
 * Usage is written under the account id; rows from before migration are under
 * the Keychain source. Both count, or a migrated account looks unused.
 */
export function usageOf(
  usage: Readonly<Record<string, { requests: number; lastUsedAt: number }>>,
  source: string,
  keyOf: (source: string) => string = accountKey,
): { requests: number; lastUsedAt: number } {
  const id = keyOf(source)
  const a = usage[id]
  const b = id === source ? undefined : usage[source]
  return {
    requests: (a?.requests ?? 0) + (b?.requests ?? 0),
    lastUsedAt: Math.max(a?.lastUsedAt ?? 0, b?.lastUsedAt ?? 0),
  }
}

const leastUsed: StrategyFn = (input) => {
  const { candidates, usage } = input
  if (Object.keys(usage).length === 0) return leastLoaded(input)
  const scored = [...candidates].sort((a, b) => {
    const ua = usageOf(usage, a.source)
    const ub = usageOf(usage, b.source)
    return ua.requests - ub.requests || ua.lastUsedAt - ub.lastUsedAt
  })
  return scored[0]!.source
}

/** Uniform choice. Cheap, stateless, and surprisingly even over many turns. */
const random: StrategyFn = ({ candidates, rng }) =>
  candidates[
    Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))
  ]!.source

/**
 * Power of two choices: sample two at random, keep the emptier.
 *
 * Gets most of `least-loaded`'s balance without always stampeding onto whichever
 * account currently looks emptiest — the classic fix for the herd effect when
 * several processes decide independently, which is exactly this plugin's
 * situation with several OpenCode windows open.
 */
const p2c: StrategyFn = (input) => {
  const { candidates, rng } = input
  if (candidates.length === 1) return candidates[0]!.source
  const i = Math.floor(rng() * candidates.length)
  let j = Math.floor(rng() * candidates.length)
  if (j === i) j = (i + 1) % candidates.length
  const a = candidates[Math.min(i, candidates.length - 1)]!
  const b = candidates[Math.min(j, candidates.length - 1)]!
  return byHeadroom(a, b) <= 0 ? a.source : b.source
}

/**
 * The registry. A new algorithm is one entry here plus one name in
 * `BalanceStrategy` — nothing else in the plugin has to know about it, and the
 * exhaustive Record makes forgetting the entry a compile error.
 */
export const STRATEGIES: Record<BalanceStrategy, StrategyFn> = {
  sticky,
  priority,
  "least-loaded": leastLoaded,
  "round-robin": roundRobin,
  weighted,
  "least-used": leastUsed,
  random,
  p2c,
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export type Decision = {
  source: string
  pool: string
  strategy: BalanceStrategy
  /** True when this differs from the account serving requests now. */
  changed: boolean
  reason: string
}

/**
 * Walk the tiers in order and let the first one with a healthy member decide.
 *
 * When every tier is exhausted, the account whose window resets soonest is
 * returned rather than nothing: the request will probably be refused, but
 * refusing to choose would strand the session with no credentials at all, and
 * the caller can say when relief arrives.
 */
export type SelectOptions = {
  /** Requests served per account, for `least-used`. */
  usage?: Record<string, { requests: number; lastUsedAt: number }>
  /** Injected for the randomised strategies. */
  rng?: () => number
  /**
   * This session has opted in to spending reserved quota. Lets a reserved
   * account serve even in hard mode; in soft mode reserved already serves as a
   * last resort, so this only widens, never narrows.
   */
  allowReserve?: boolean
}

export function selectAccount(
  members: readonly Member[],
  cache: QuotaCache,
  cfg: ClaudeAuthConfig,
  activeSource: string | null,
  nowMs: number = Date.now(),
  opts: SelectOptions = {},
): Decision | undefined {
  const pools = resolvePools(members, cfg)
  if (pools.length === 0) return undefined

  const health = new Map(
    assess(members, cache, cfg, nowMs).map((h) => [h.source, h]),
  )

  for (const pool of pools) {
    const candidates = pool.accounts
      .map((s) => health.get(s))
      .filter((h): h is Health => !!h && h.healthy)
    if (candidates.length === 0) continue

    const strategy = pool.strategy ?? cfg.strategy
    const fn = STRATEGIES[strategy] ?? sticky
    const source = fn({
      candidates,
      activeSource,
      pool,
      usage: opts.usage ?? {},
      rng: opts.rng ?? Math.random,
    })
    return {
      source,
      pool: pool.name,
      strategy,
      changed: source !== activeSource,
      reason:
        source === activeSource
          ? "already active"
          : `${strategy} over ${candidates.length} healthy in ${pool.name}`,
    }
  }

  // No account is under the threshold. That is not the same as no account being
  // usable: switchAt is a margin, not the limit. An account at 98% with the
  // server still answering `allowed` will serve requests perfectly well, and
  // declaring exhaustion because every account sits in the 95-100% band tells
  // the operator to wait while three working accounts sit idle.
  //
  // So separate the two cases. Anything the server has not actually refused, and
  // that is not literally at its limit, is a degraded-but-usable fallback.
  const all = pools.flatMap((p) => p.accounts)
  const known = all.map((s) => health.get(s)).filter((h): h is Health => !!h)

  // Over switchAt but still serving, and NOT reserved: a reserved account has
  // free allowance deliberately withheld, so it waits for its own tier rather
  // than being spent here.
  const overThresholdButServing = known
    .filter(
      (h) =>
        h.credential !== "unusable" &&
        h.reason !== "server rejected" &&
        !h.reason.startsWith("ejected") &&
        !h.reserved &&
        (h.utilization ?? 0) < 1,
    )
    .sort(byHeadroom)

  const fallback = overThresholdButServing[0]
  if (fallback) {
    return {
      source: fallback.source,
      pool: "over-threshold",
      strategy: cfg.strategy,
      changed: fallback.source !== activeSource,
      reason: `every account is above switchAt; using the emptiest still serving (${Math.round((fallback.utilization ?? 0) * 100)}%)`,
    }
  }

  // Reserved accounts: past their ceiling but with free allowance left. Served
  // only when the mode permits -- soft always, hard only with a session
  // override -- and then the one least past its ceiling (emptiest reserve).
  const reserveAllowed = cfg.capMode === "soft" || opts.allowReserve === true
  if (reserveAllowed) {
    const reservedServing = known
      .filter(
        (h) =>
          h.reserved === true &&
          h.credential !== "unusable" &&
          h.reason !== "server rejected" &&
          !h.reason.startsWith("ejected") &&
          (h.utilization ?? 0) < 1,
      )
      .sort((a, b) => (a.reservedMargin ?? 0) - (b.reservedMargin ?? 0))
    const reserved = reservedServing[0]
    if (reserved) {
      return {
        source: reserved.source,
        pool: "reserved",
        strategy: cfg.strategy,
        changed: reserved.source !== activeSource,
        reason: `every free account is spent; drawing on reserved quota (${Math.round((reserved.reservedMargin ?? 0) * 100 + 0)}% past ceiling)`,
      }
    }
  }

  // Spent on the included allowance, but credits are covering it -- so it
  // serves, for money. Deliberately below both free tiers: a free account at
  // 98% is cheaper than a paid one, and enabling credits must not start
  // spending them while any free headroom remains.
  // Declining to route is the only lever there is: no API turns credits off,
  // and this credential could not use one if it existed. So `useCredits: false`
  // keeps THIS plugin's traffic free; another client on the same account still
  // spends.
  const paidButServing = (cfg.useCredits === false ? [] : known)
    .filter(
      (h) =>
        h.credential !== "unusable" &&
        !h.reason.startsWith("ejected") &&
        h.paidCapacity === true,
    )
    .sort(byHeadroom)

  const paid = paidButServing[0]
  if (paid) {
    return {
      source: paid.source,
      pool: "credits",
      strategy: cfg.strategy,
      changed: paid.source !== activeSource,
      reason:
        "every account has spent its included allowance; using credits on the emptiest",
    }
  }

  // Genuinely nothing left: refused, ejected, at the limit with no credits, or
  // credits themselves capped. Prefer whoever frees up first.
  const soonest = known.sort(
    (a, b) => (a.resetsAt ?? Infinity) - (b.resetsAt ?? Infinity),
  )[0]
  if (!soonest) return undefined

  return {
    source: soonest.source,
    pool: "exhausted",
    strategy: cfg.strategy,
    changed: soonest.source !== activeSource,
    reason: soonest.resetsAt
      ? `all accounts spent, credits exhausted or unavailable; earliest reset at ${new Date(soonest.resetsAt * 1000).toISOString()}`
      : "all accounts spent, credits exhausted or unavailable; no reset time known",
  }
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

/**
 * When each spent account can serve again, soonest first.
 *
 * An account is free once EVERY window holding it back has reset: a 5h reset
 * does not help an account whose week is also full, so the time is the latest
 * reset among its blocking windows (and any ejection). Accounts that cannot
 * authenticate, or whose blocking window has no known reset, are left out
 * rather than given a guessed time.
 */
export function recoveryTimes(
  members: readonly Member[],
  cache: QuotaCache,
  cfg: Pick<ClaudeAuthConfig, "switchAt">,
  nowMs: number = Date.now(),
): { source: string; at: number }[] {
  const nowSec = Math.floor(nowMs / 1000)
  const out: { source: string; at: number }[] = []
  for (const m of members) {
    if (m.credential === "unusable") continue
    const q = quotaForAccount(m.source, cache, nowSec)
    let at = ejectedUntil(m.source, nowMs) ?? 0
    let unknown = false
    for (const w of [q?.fiveHour, q?.sevenDay]) {
      if (!w || w.resetsAt === undefined || w.resetsAt <= nowSec) {
        if (w && w.resetsAt === undefined && w.utilization >= cfg.switchAt)
          unknown = true
        continue
      }
      if (w.status === "rejected" || w.utilization >= cfg.switchAt)
        at = Math.max(at, w.resetsAt * 1000)
    }
    if (unknown || at <= nowMs) continue
    out.push({ source: m.source, at })
  }
  return out.sort((a, b) => a.at - b.at)
}

/** How often a spent pool is re-checked while OpenCode waits to retry. */
export const SPENT_RECHECK_S = 60
/** OpenCode caps a retry-after at 15 minutes. */
export const SPENT_RECHECK_MAX_S = 900
/**
 * How many times OpenCode retries a 429: 10 as of 2.2.x. Spreading the wait
 * over all but one of them lands a retry at the reset, so the request resumes
 * by itself instead of failing after ten one-minute checks. A different
 * OpenCode can be matched with OPENCODE_CLAUDE_AUTH_HOST_RETRIES.
 */
export const HOST_RETRIES = 10

export function hostRetries(env: NodeJS.ProcessEnv = process.env): number {
  const n = parseInt(env.OPENCODE_CLAUDE_AUTH_HOST_RETRIES ?? "", 10)
  return Number.isNaN(n) || n < 2 ? HOST_RETRIES : n
}

/**
 * The retry the operator sees when every account refused: the real time the
 * next account is back, and a retry-after paced so OpenCode's bounded retries
 * reach that time -- never shorter than a minute, so a reset, an added account
 * or a changed selection is still picked up on a later check.
 */
export function spentRetry(
  next: { name: string; at: number } | undefined,
  nowMs: number,
  clock: (ms: number) => string,
  serverRetryAfterS?: number,
  retries: number = hostRetries(),
  sinceMs: number = nowMs,
): { retryAfterS: number; message: string } {
  const wait = next ? Math.ceil((next.at - nowMs) / 1000) : undefined
  // Paced from when the pool went spent, not from now: OpenCode does not say how
  // many retries a request has left, and dividing the remaining wait by all of
  // them again on every retry shrinks the step until the retries run out early.
  const span = next ? Math.ceil((next.at - Math.min(sinceMs, nowMs)) / 1000) : 0
  const every =
    wait === undefined
      ? SPENT_RECHECK_S
      : Math.min(
          SPENT_RECHECK_MAX_S,
          Math.max(SPENT_RECHECK_S, Math.ceil(span / (retries - 1))),
        )
  const candidates = [every, wait, serverRetryAfterS].filter(
    (v): v is number => v !== undefined && v > 0,
  )
  const retryAfterS = Math.max(1, Math.min(...candidates))
  const message = next
    ? `Every account is spent. Next back: ${next.name} at ${clock(next.at)} (in ${formatDuration(wait!)}). Re-checking every ${formatDuration(every)}, so freeing or adding an account is picked up on the next check.`
    : `Every account is spent and no reset time is known. Re-checking every ${SPENT_RECHECK_S}s.`
  return { retryAfterS, message }
}
