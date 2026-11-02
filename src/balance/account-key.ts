/**
 * The key telemetry and the quota cache are grouped by.
 *
 * An account's Keychain `source` is an implementation detail -- renamed,
 * re-suffixed, re-logged-in -- so every durable store (quota cache, usage log,
 * samples) keys by the stable account id instead, resolved through the identity
 * cache and the `accountIds` registry. This module is the single seam that does
 * that resolution, so the rest of the plugin keeps passing a `source` and never
 * has to know an id exists.
 *
 * A pure core (`resolveAccountKey`, `readKeysFor`) takes the identity cache and
 * registry explicitly and is tested without a file or the config; the live
 * shells read both from disk. An account with no id -- an un-migrated install,
 * or a pair not yet resolved -- keys by its source exactly as before, which is
 * what lets old source-keyed data keep reading.
 */

import { getConfig } from "../config.ts"
import { accountIdFor, cacheReadKeys } from "./accounts-id.ts"
import { type IdentityCache, readIdentityCache } from "./identity.ts"

/** The id a WRITE for this source should key on, given explicit stores. */
export function resolveAccountKey(
  source: string,
  identities: IdentityCache,
  registry: Parameters<typeof accountIdFor>[2],
): string {
  return accountIdFor(source, identities, registry)
}

/** The keys a READ for this source should try, id first then raw source. */
export function readKeysFor(
  source: string,
  identities: IdentityCache,
  registry: Parameters<typeof cacheReadKeys>[2],
): string[] {
  return cacheReadKeys(source, identities, registry)
}

/**
 * The live write key: the account id when one is registered, else the source.
 *
 * Reads the identity cache and config registry from disk. Both reads are
 * swallowed to the source on any failure, because a key that falls back to the
 * source is correct for an un-migrated install and must never fail a request.
 */
export function accountKey(source: string): string {
  try {
    return resolveAccountKey(
      source,
      readIdentityCache(),
      getConfig().accountIds,
    )
  } catch {
    return source
  }
}

/** The live read keys: id first (new writes), then source (old writes). */
export function accountReadKeys(source: string): string[] {
  try {
    return readKeysFor(source, readIdentityCache(), getConfig().accountIds)
  } catch {
    return [source]
  }
}
