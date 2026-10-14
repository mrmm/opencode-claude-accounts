// Which store owns an account's credentials.
//
// Upstream decides where a token lives from the source id alone: "file" means
// ~/.claude/.credentials.json, anything else is a macOS Keychain service. That
// breaks the moment an account lives anywhere else — a second config directory
// on Linux, or a secret broker that must never put the token on disk — and it
// broke quietly: several refresh paths call refreshAccount(source) with no
// config directory, so a non-default file account fell through to the Keychain
// reader and came back empty.
//
// This registry is the single answer. Every account read from a non-Keychain
// store is registered here, and the read and write-back paths ask it first. It
// imports nothing at runtime so that keychain.ts (upstream-owned) can depend on
// it without dragging the rest of the domain into its module graph.
import type { ClaudeAccount, ClaudeCredentials } from "../keychain.ts"

export type StoreKind = "keychain" | "file" | "helper"

export interface CredentialStore {
  /** Account id: the source used everywhere else (balancer, presets, pins). */
  source: string
  kind: StoreKind
  label: string
  configDir?: string
  read(): ClaudeCredentials | null
  write(creds: ClaudeCredentials): boolean
}

const stores = new Map<string, CredentialStore>()
let declared: string[] | null = null
let mirror = true

export function registerStore(store: CredentialStore): void {
  stores.set(store.source, store)
}

/** Replace the declared account list. An empty list means "discover instead". */
export function setDeclaredStores(list: CredentialStore[]): void {
  for (const s of list) registerStore(s)
  declared = list.length > 0 ? list.map((s) => s.source) : null
}

export function clearStores(): void {
  stores.clear()
  declared = null
  mirror = true
}

/**
 * The store that handles reads and writes for a source, or undefined when the
 * native path does. Keychain stores are declared only to be listed — their
 * reads and writes stay on upstream's code, keyed by the service name.
 */
export function storeFor(source: string): CredentialStore | undefined {
  const s = stores.get(source)
  return s && s.kind !== "keychain" ? s : undefined
}

/** Accounts from declared stores, in declaration order; null when none are declared. */
export function declaredAccounts(): ClaudeAccount[] | null {
  if (!declared) return null
  const out: ClaudeAccount[] = []
  for (const source of declared) {
    const s = stores.get(source)
    if (!s) continue
    const credentials = s.read()
    if (!credentials) continue
    const account: ClaudeAccount = {
      label: s.label,
      source: s.source,
      credentials,
    }
    if (s.configDir) account.configDir = s.configDir
    out.push(account)
  }
  return out
}

/**
 * Whether the live token is copied into OpenCode's auth.json. On a host where
 * tokens must not touch disk the mirror is the one remaining plaintext copy, so
 * it can be turned off; requests never read it (the token is resolved per
 * request in the plugin's own fetch).
 */
export function setAuthJsonMirror(on: boolean): void {
  mirror = on
}

export function authJsonMirrorEnabled(): boolean {
  return mirror
}
