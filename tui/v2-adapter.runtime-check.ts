// Runtime check of the V2 adapter shim: run with `bun tui/v2-adapter.runtime-check.ts`.
// Type-checking cannot catch a member missing at runtime, which is how the
// "api.event.on" crash shipped, so this drives the adapter with a fake V2 context.
import assert from "node:assert/strict"

import { setupV2 } from "./v2-adapter.tsx"

const prompts: unknown[] = []
const synced: string[] = []
let loaded = false
const ctx = {
  options: {},
  location: { directory: "/repo" },
  theme: {},
  ui: { toast: { show() {} }, dialog: {}, slot() {} },
  keymap: { layer() {} },
  client: {
    session: {
      prompt: async (input: unknown) => {
        prompts.push(input)
        return {}
      },
    },
  },
  data: {
    session: {
      get: (id: string) =>
        id === "s1"
          ? {
              id,
              parentID: undefined,
              time: { created: 1 },
              location: { directory: "/repo/wt" },
            }
          : undefined,
      message: {
        list: () =>
          loaded
            ? [
                { id: "u1", type: "user", text: "hi" },
                {
                  id: "a1",
                  type: "assistant",
                  cost: 0.5,
                  tokens: {
                    input: 1,
                    output: 2,
                    reasoning: 0,
                    cache: { read: 3, write: 4 },
                  },
                  content: [
                    { type: "text", text: "ok" },
                    {
                      type: "tool",
                      name: "bash",
                      state: {
                        status: "completed",
                        input: { command: "git status" },
                        content: [{ type: "text", text: "clean" }],
                      },
                    },
                  ],
                },
              ]
            : undefined,
        sync: async (id: string) => {
          synced.push(id)
        },
      },
    },
  },
}

let api: any
setupV2(
  ctx as never,
  (async (a: unknown) => {
    api = a
  }) as never,
)
await new Promise((r) => setTimeout(r, 0))

// Not loaded yet: empty, and one sync requested.
assert.deepEqual(api.state.session.messages("s1"), [])
api.state.session.messages("s1")
assert.deepEqual(synced, ["s1"])

loaded = true
const msgs = api.state.session.messages("s1")
assert.deepEqual(
  msgs.map((m: any) => m.role),
  ["user", "assistant"],
)
assert.equal(msgs[1].tokens.cache.read, 3)
assert.deepEqual(api.state.part("a1"), [
  {
    type: "tool",
    tool: "bash",
    state: {
      status: "completed",
      input: { command: "git status" },
      output: "clean",
    },
  },
])
assert.equal(api.state.session.get("s1").directory, "/repo/wt")
assert.equal(api.state.path.directory, "/repo")

const res = await api.client.session.promptAsync({
  sessionID: "s1",
  parts: [{ text: "a" }, { text: "b" }],
})
assert.equal(res.error, undefined)
assert.deepEqual(prompts, [{ sessionID: "s1", text: "a\nb" }])

console.log("v2 adapter runtime check: ok")

// The whole plugin's startup through the adapter, with slot renders and the
// command list actually invoked: a missing V1 member throws here, not in the TUI.
const { default: plugin } = await import("./claude-auth-tui.tsx")
const failures: string[] = []
const toasts: string[] = []
const slots: Array<(p: unknown) => unknown> = []
const dispatched: string[] = []
let dialogOptions: Array<{ title: string; value: unknown; category?: string }> =
  []
let pick: unknown
let layer: any

// A clipboard stand-in on PATH, so the check never overwrites the real clipboard.
const {
  mkdtempSync,
  writeFileSync: write,
  chmodSync,
  readFileSync: readF,
} = await import("node:fs")
const { tmpdir } = await import("node:os")
const bin = mkdtempSync(`${tmpdir()}/clip-`)
for (const name of ["pbcopy", "wl-copy"]) {
  write(`${bin}/${name}`, `#!/bin/sh\ncat > ${bin}/clipboard\n`)
  chmodSync(`${bin}/${name}`, 0o755)
}
process.env.PATH = `${bin}:${process.env.PATH}`

const full = {
  ...ctx,
  ui: {
    ...ctx.ui,
    toast: {
      show: (t: { message: string; variant?: string }) => {
        toasts.push(t.message)
        if (t.variant === "error") failures.push(t.message)
      },
    },
    slot: (s: { render: (p: unknown) => unknown }) => slots.push(s.render),
    dialog: {
      select: async (o: { options: typeof dialogOptions }) => {
        dialogOptions = o.options
        return pick
      },
    },
  },
  keymap: {
    layer: (f: () => unknown) => (layer = f()),
    dispatch: (id: string) => dispatched.push(id),
  },
}
plugin.setup(full as never)
await new Promise((r) => setTimeout(r, 200))
assert.deepEqual(failures, [], "plugin setup reported an error")
// JSX needs the real renderer; the code before the JSX (session tracking, the
// new-session toast) still runs, and any other error fails the check.
for (const render of slots) {
  try {
    render({ sessionID: "s1" })
  } catch (e) {
    if ((e as Error).message !== "No renderer found") throw e
  }
}
assert.ok(slots.length >= 3, `expected sidebar slots, got ${slots.length}`)
assert.ok(
  layer.commands.some((c: any) => c.slash?.name === "optimize"),
  "/optimize registered",
)
await layer.commands.find((c: any) => c.slash?.name === "optimize").run()
await new Promise((r) => setTimeout(r, 50))
assert.equal(prompts.length, 2, "/optimize sent one prompt")
assert.match((prompts[1] as { text: string }).text, /Token optimisation report/)
// /tokens: the dialog lists actions and every report row; "paste" copies the full
// report and fires the TUI's own paste command.
const tokens = layer.commands.find((c: any) => c.slash?.name === "tokens")
assert.ok(tokens, "/tokens registered")
pick = "paste"
await tokens.run()
await new Promise((r) => setTimeout(r, 120))
assert.deepEqual(
  dialogOptions.slice(0, 3).map((o) => o.value),
  ["paste", "copy", "optimize"],
)
assert.ok(
  dialogOptions.some((o) => o.category?.startsWith("Optimize")),
  "report rows listed",
)
assert.deepEqual(dispatched, ["prompt.paste"])
assert.match(readF(`${bin}/clipboard`, "utf-8"), /Token optimisation report/)
assert.deepEqual(failures, [])

console.log(
  `plugin setup through adapter: ok (${slots.length} slots, /optimize sent, /tokens pastes ${dialogOptions.length} rows)`,
)
// The plugin keeps refresh timers running; nothing else to wait for.
process.exit(0)
