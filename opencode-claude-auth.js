// Entry point for both OpenCode generations, from one default export:
//   V1 (>= 1.18.29) calls server() and uses the hooks it returns.
//   V2 reads id + setup() and ignores server().
// Only the default is exported: V1's loader also invokes named function
// exports, which would initialise the plugin twice.
import ClaudeAuthPlugin from "./dist/index.js"

export default {
  id: "claude-accounts",
  async setup(ctx) {
    // Loaded lazily so V1 never evaluates the V2 adapter.
    const { setup } = await import("./dist/v2.js")
    return setup(ctx, ClaudeAuthPlugin)
  },
  server: ClaudeAuthPlugin,
}
