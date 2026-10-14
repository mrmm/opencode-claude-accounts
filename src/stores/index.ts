// Barrel for the credential-store domain. Upstream-owned files import this, and
// only this, so each of their edits stays one line.
import type { ClaudeAuthConfig } from "../config.ts"
import { buildStore } from "./build.ts"
import { setAuthJsonMirror, setDeclaredStores } from "./registry.ts"

export {
  authJsonMirrorEnabled,
  clearStores,
  declaredAccounts,
  registerStore,
  storeFor,
  type CredentialStore,
} from "./registry.ts"
export { readFileAccounts } from "./discover.ts"

/** Apply the store-related config. Called once at plugin start. */
export function configureStores(
  config: Pick<ClaudeAuthConfig, "stores" | "authJsonMirror">,
): void {
  setDeclaredStores(config.stores.map((spec) => buildStore(spec)))
  setAuthJsonMirror(config.authJsonMirror)
}
