// Turn declared StoreSpecs into live stores.
//
// Each backend reuses upstream's own readers and writers where it can, so a
// file store reads and writes exactly like upstream's ~/.claude path and a
// Keychain store stays on upstream's Keychain code. Only `helper` is new I/O.
import type { StoreSpec } from "../config.ts"
// Namespace import, deliberately: keychain.ts imports this domain, and tests
// load keychain.ts stand-ins that export only what they exercise. Named
// imports would make every such stand-in fail to link; a namespace resolves
// each function when a store is actually used.
import * as keychain from "../keychain.ts"
import type { ClaudeCredentials } from "../keychain.ts"
import { log } from "../logger.ts"
import { emitNotice } from "../notify.ts"
import { runHelper, type Exec } from "./helper.ts"
import type { CredentialStore } from "./registry.ts"

/** How long a helper read is reused, and how close to expiry it stops being reused. */
export const HELPER_CACHE_MS = 60_000
export const HELPER_EXPIRY_MARGIN_MS = 5 * 60_000

/** Claude Code's on-disk shape, for a helper that has nothing stored yet. */
export function freshBlob(c: ClaudeCredentials): string {
  return JSON.stringify({ claudeAiOauth: { ...c } })
}

export function buildStore(spec: StoreSpec, exec?: Exec): CredentialStore {
  const label = spec.name ?? spec.id

  if (spec.backend === "file") {
    const dir = spec.configDir ?? ""
    return {
      source: spec.id,
      kind: "file",
      label,
      configDir: dir,
      read: () => keychain.readCredentialsFile(dir),
      // "file" + configDir is upstream's own write path for a credentials file.
      write: (c) => keychain.writeBackCredentials("file", c, dir),
    }
  }

  if (spec.backend === "keychain") {
    const service = spec.service ?? spec.id
    return {
      source: service,
      kind: "keychain",
      label,
      read: () => keychain.refreshAccount(service),
      write: (c) => keychain.writeBackCredentials(service, c),
    }
  }

  const command = spec.command ?? []
  let last: string | null = null
  // The helper runs synchronously (the store API is sync) and a broker read can take
  // seconds, which stalls the whole host process. A read is reused for a short window
  // unless the token is about to expire; a write-back refreshes it.
  let cached: ClaudeCredentials | null = null
  let cachedAt = 0
  const fresh = (now: number) =>
    cached !== null &&
    now - cachedAt < HELPER_CACHE_MS &&
    cached.expiresAt - now > HELPER_EXPIRY_MARGIN_MS
  const get = () => {
    const raw = runHelper(command, "get", spec.id, undefined, exec)
    if (raw && raw.trim()) last = raw
    return raw
  }
  return {
    source: spec.id,
    kind: "helper",
    label,
    read: () => {
      const now = Date.now()
      if (fresh(now)) return cached
      const raw = get()
      const creds = raw && raw.trim() ? keychain.parseCredentials(raw) : null
      log("helper_read", { store: spec.id, found: creds !== null })
      cached = creds
      cachedAt = now
      return creds
    },
    write: (c) => {
      // Update in place so fields the plugin does not model (scopes, account
      // metadata) survive a refresh. The base is the blob this store last READ, not
      // a fresh get(): on a broker a get spends a granted read, and a write-back
      // must not be what exhausts a read budget.
      const blob =
        (last && keychain.updateCredentialBlob(last, c)) || freshBlob(c)
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (runHelper(command, "store", spec.id, blob, exec) !== null) {
          last = blob
          cached = c
          cachedAt = Date.now()
          log("helper_write", { store: spec.id, success: true, attempt })
          return true
        }
      }
      // Anthropic has already rotated the refresh token: losing this write means a
      // re-login, so it is surfaced, not just logged.
      log("helper_write", { store: spec.id, success: false })
      emitNotice({
        kind: "refresh-failed",
        source: spec.id,
        reason:
          "the refreshed token could not be written back to its store; log in again if requests start failing",
      })
      return false
    },
  }
}
