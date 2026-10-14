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
      const raw = get()
      const creds = raw && raw.trim() ? keychain.parseCredentials(raw) : null
      log("helper_read", { store: spec.id, found: creds !== null })
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
