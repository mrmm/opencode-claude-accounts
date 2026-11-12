/**
 * Account identity: resolving each Keychain account to the stable pair that
 * uniquely names it -- `{ accountUuid, orgUuid }` -- plus the email and org name
 * that make it legible.
 *
 * Why this exists: a Keychain source name is an implementation detail (it is
 * renamed, re-suffixed, re-logged-in), and neither uuid alone is unique -- the
 * same login appears in several orgs. The (account, org) pair is the only key
 * that survives those changes, and it comes from the profile endpoint, not from
 * anything on disk. `.claude.json` is a fallback only: a spike showed it
 * resolves the primary account to the wrong org and is empty for a third of
 * config dirs.
 *
 * I/O is deliberately split out: `parseProfile` and the cache merge are pure and
 * tested without a network, while `fetchIdentity` is the thin shell. Identity is
 * fetched when a token is known fresh (load / probe / refresh) and cached, never
 * on the request path.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import { withFileLock } from "./file-lock.ts"
import { dataFile } from "../paths.ts"

/** The uniquely-identifying pair plus the fields that make it readable. */
export type AccountIdentity = {
  accountUuid: string
  orgUuid: string
  email?: string
  orgName?: string
  /** organization_type, e.g. claude_team. */
  plan?: string
  /** rate_limit_tier, e.g. default_claude_max_5x. */
  tier?: string
  /** subscription_status, e.g. active. Anything else is worth a warning. */
  subscription?: string
}

/** One cache row: an identity plus when it was fetched, keyed by Keychain source. */
export type CachedIdentity = AccountIdentity & { fetchedAt: number }

export type IdentityCache = Record<string, CachedIdentity>

/** How long a cached profile row is trusted for plan and subscription. */
export const IDENTITY_MAX_AGE_S = 24 * 60 * 60

export const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"

/** Next to the quota cache, so both live under one directory. */
export function identityCachePath(): string {
  return dataFile("identities.json")
}

/** Build the profile request. Same oauth beta header the rest of the plugin uses. */
export function buildProfileRequest(
  accessToken: string,
): [string, RequestInit] {
  return [
    PROFILE_URL,
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      // A hung connection must not stall the identity sweep.
      signal: AbortSignal.timeout(5_000),
    },
  ]
}

/**
 * Pull an identity out of a profile body. Returns undefined for anything missing
 * the two uuids, since without the pair there is nothing to key on.
 */
export function parseProfile(body: unknown): AccountIdentity | undefined {
  if (!body || typeof body !== "object") return undefined
  const b = body as {
    account?: { uuid?: unknown; email?: unknown; email_address?: unknown }
    organization?: Record<string, unknown> & { uuid?: unknown }
  }
  const accountUuid = b.account?.uuid
  const orgUuid = b.organization?.uuid
  if (typeof accountUuid !== "string" || typeof orgUuid !== "string")
    return undefined
  const out: AccountIdentity = { accountUuid, orgUuid }
  // The profile endpoint says `email`; `email_address` is the older spelling.
  const email = b.account?.email ?? b.account?.email_address
  if (typeof email === "string") out.email = email
  const o = b.organization ?? {}
  if (typeof o.name === "string") out.orgName = o.name
  if (typeof o.organization_type === "string") out.plan = o.organization_type
  if (typeof o.rate_limit_tier === "string") out.tier = o.rate_limit_tier
  if (typeof o.subscription_status === "string")
    out.subscription = o.subscription_status
  return out
}

/**
 * The `.claude.json` fallback: `oauthAccount` carries the pair and email for a
 * config dir. Known to be wrong for the primary account and empty for some
 * dirs, so it is only ever consulted when the profile endpoint gave nothing.
 */
export function identityFromConfigDir(
  configDir: string,
): AccountIdentity | undefined {
  // ~/.claude.json belongs to the default config dir only; using it for any
  // other dir would give two accounts one identity, and migration would make
  // that collision permanent.
  const candidates = [join(configDir, ".claude.json")]
  if (configDir === join(homedir(), ".claude"))
    candidates.push(join(homedir(), ".claude.json"))
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue
      const data = JSON.parse(readFileSync(path, "utf8")) as {
        oauthAccount?: {
          accountUuid?: unknown
          organizationUuid?: unknown
          emailAddress?: unknown
        }
      }
      const acc = data.oauthAccount
      if (typeof acc?.accountUuid !== "string") continue
      if (typeof acc?.organizationUuid !== "string") continue
      const out: AccountIdentity = {
        accountUuid: acc.accountUuid,
        orgUuid: acc.organizationUuid,
      }
      if (typeof acc.emailAddress === "string") out.email = acc.emailAddress
      return out
    } catch {
      // A malformed .claude.json is no identity, not a crash.
    }
  }
  return undefined
}

export function readIdentityCache(
  path: string = identityCachePath(),
): IdentityCache {
  try {
    if (!existsSync(path)) return {}
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    return parsed && typeof parsed === "object" ? (parsed as IdentityCache) : {}
  } catch {
    return {}
  }
}

/**
 * readIdentityCache for the request path: re-read only when the file changed.
 * accountKey and id resolution run per request; the file changes once per probe.
 */
let memo: { path: string; mtimeMs: number; cache: IdentityCache } | undefined
export function readIdentityCacheFresh(
  path: string = identityCachePath(),
): IdentityCache {
  try {
    const mtimeMs = statSync(path).mtimeMs
    if (memo && memo.path === path && memo.mtimeMs === mtimeMs)
      return memo.cache
    const cache = readIdentityCache(path)
    memo = { path, mtimeMs, cache }
    return cache
  } catch {
    return {}
  }
}

/** Never throws: this runs detached and must not surface as a failed request. */
export function writeIdentity(
  source: string,
  identity: AccountIdentity,
  now: number = Math.floor(Date.now() / 1000),
  path: string = identityCachePath(),
): boolean {
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return withFileLock(path, () => {
      const cache = readIdentityCache(path)
      cache[source] = { ...identity, fetchedAt: now }
      // tmp + rename: the server and the TUI both write this file, and a torn
      // write would lose every account's identity.
      const tmp = `${path}.tmp-${process.pid}`
      // Emails and org names: owner-only.
      writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      })
      renameSync(tmp, path)
      return true
    })
  } catch {
    return false
  }
}

export type IdentityAccount = {
  source: string
  accessToken: string
  configDir?: string
}

export type IdentityResult = { fetched: number; cached: number; failed: number }

/**
 * Resolve identities for accounts with a fresh token, writing what it learns.
 *
 * Resolves rather than rejects: it runs detached from start-up and must never
 * reach the user as an error. An account cached within a day, with its plan,
 * is skipped; an older row is refreshed from the profile only. A 401
 * (expired token) keeps whatever identity is already cached rather than erasing
 * it -- the pair does not change when a token lapses.
 */
export async function fetchIdentities(
  accounts: IdentityAccount[],
  options: {
    fetchImpl?: typeof fetch
    path?: string
    now?: () => number
  } = {},
): Promise<IdentityResult> {
  const {
    fetchImpl = fetch,
    path = identityCachePath(),
    now = () => Math.floor(Date.now() / 1000),
  } = options

  const result: IdentityResult = { fetched: 0, cached: 0, failed: 0 }
  const cache = readIdentityCache(path)

  // In parallel: N accounts in series cost N round trips at start-up. Each
  // write takes the file lock, so concurrent results do not overwrite each other.
  await Promise.all(
    (accounts ?? []).map(async (account) => {
      if (!account?.source || !account?.accessToken) {
        result.failed++
        return
      }
      // The pair never changes, but plan and subscription do: refetch a row
      // a day old, or one written before those fields were kept.
      const held = cache[account.source]
      if (
        held &&
        held.plan !== undefined &&
        now() - held.fetchedAt < IDENTITY_MAX_AGE_S
      ) {
        result.cached++
        return
      }
      try {
        const [url, init] = buildProfileRequest(account.accessToken)
        const res = await fetchImpl(url, init)
        // A row already held is only ever refreshed from the profile itself:
        // the disk fallback is known to name the wrong org, and the pair it
        // holds keys every account id.
        const keepHeld = () => {
          if (!held) return false
          result.cached++
          return true
        }
        if (res.status === 401) {
          // Expired token: keep any cached identity, fall back to disk otherwise.
          if (keepHeld()) return
          const fallback = account.configDir
            ? identityFromConfigDir(account.configDir)
            : undefined
          if (fallback) {
            writeIdentity(account.source, fallback, now(), path)
            result.fetched++
          } else {
            result.failed++
          }
          return
        }
        const identity = parseProfile(await res.json().catch(() => null))
        if (
          identity &&
          held &&
          (identity.accountUuid !== held.accountUuid ||
            identity.orgUuid !== held.orgUuid)
        ) {
          // A different pair under the same source is a re-login, which
          // migration handles; a refresh must not rekey the account.
          result.cached++
        } else if (identity) {
          writeIdentity(account.source, identity, now(), path)
          result.fetched++
        } else if (keepHeld()) {
          return
        } else {
          const fallback = account.configDir
            ? identityFromConfigDir(account.configDir)
            : undefined
          if (fallback) {
            writeIdentity(account.source, fallback, now(), path)
            result.fetched++
          } else {
            result.failed++
          }
        }
      } catch {
        result.failed++
      }
    }),
  )

  return result
}
