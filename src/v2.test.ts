import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { primeConfig, resetConfigCache } from "./config.ts"
import { PLUGIN_ID, setup } from "./v2.ts"

type Callback = (event: Record<string, unknown>) => unknown

/** A V2 context that records what the adapter registers. */
function fakeContext() {
  const providerEdits: Array<(editor: unknown) => void> = []
  const modelEdits: Array<(editor: unknown) => void> = []
  const sessionHooks = new Map<string, Callback[]>()
  const tools: Array<{
    name: string
    execute: (i: unknown, c: unknown) => Promise<{ content: string }>
  }> = []
  const methods: unknown[] = []
  const registration = { dispose: async () => {} }
  const ctx = {
    location: { directory: "/tmp", project: { directory: "/tmp" } },
    options: {},
    provider: {
      transform: async (cb: (editor: unknown) => void) => {
        providerEdits.push(cb)
        return registration
      },
    },
    model: {
      transform: async (cb: (editor: unknown) => void) => {
        modelEdits.push(cb)
        return registration
      },
    },
    session: {
      hook: async (name: string, cb: Callback) => {
        sessionHooks.set(name, [...(sessionHooks.get(name) ?? []), cb])
        return registration
      },
    },
    integration: {
      transform: async (cb: (editor: unknown) => void) => {
        cb({ method: { update: (m: unknown) => methods.push(m) } })
        return registration
      },
      reload: async () => {},
    },
    tool: {
      transform: async (cb: (editor: unknown) => void) => {
        cb({ add: (t: (typeof tools)[number]) => tools.push(t) })
        return registration
      },
    },
  }
  return { ctx, providerEdits, modelEdits, sessionHooks, tools, methods }
}

describe("v2 adapter", () => {
  it("routes the anthropic provider through the V1 fetch and adapts its hooks", async () => {
    const seen: Array<{ url: string; body: unknown; session: string | null }> =
      []
    const v1 = async () => ({
      "chat.headers": async (
        input: { sessionID: string },
        output: { headers: Record<string, string> },
      ) => {
        output.headers["x-test-session"] = input.sessionID
      },
      auth: {
        provider: "anthropic",
        loader: async () => ({
          fetch: async (input: string, init: RequestInit) => {
            seen.push({
              url: input,
              body: init.body,
              session: new Headers(init.headers).get("x-test-session"),
            })
            return new Response("data: ok\n\n", {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            })
          },
        }),
        methods: [],
      },
      tool: {
        echo: {
          description: "echo",
          args: {},
          execute: async () => "echoed",
        },
      },
    })

    const { ctx, providerEdits, sessionHooks, tools } = fakeContext()
    const cleanup = await setup(ctx as never, v1 as never)
    try {
      // The provider's baseURL now points at the loopback proxy.
      const draft: { settings?: Record<string, unknown> } = {}
      providerEdits[0]!({
        update: (_id: string, fn: (p: typeof draft) => void) => fn(draft),
      })
      const baseURL = String(draft.settings?.baseURL)
      assert.match(baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/)

      // chat.headers became a model.request hook.
      const headers: Record<string, string> = {}
      await sessionHooks.get("model.request")![0]!({
        sessionID: "ses_1",
        agent: "build",
        model: { providerID: "anthropic", id: "claude-x" },
        headers,
      })
      assert.equal(headers["x-test-session"], "ses_1")

      // A request to the proxy reaches the V1 fetch against the real upstream.
      const res = await fetch(`${baseURL}/messages?beta=true`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-x" }),
      })
      assert.equal(res.status, 200)
      assert.equal(await res.text(), "data: ok\n\n")
      assert.equal(
        seen[0]?.url,
        "https://api.anthropic.com/v1/messages?beta=true",
      )
      assert.equal(seen[0]?.body, JSON.stringify({ model: "claude-x" }))
      assert.equal(seen[0]?.session, "ses_1")

      // V1 tools are registered with V2 results.
      assert.equal(tools[0]?.name, "echo")
      assert.deepEqual(await tools[0]!.execute({}, {}), { content: "echoed" })
    } finally {
      await (cleanup as () => void)()
    }
  })

  it("caps the context window at contextLimit and leaves smaller models alone", async () => {
    primeConfig("/tmp", { contextLimit: 400000 })
    try {
      const { ctx, modelEdits } = fakeContext()
      await setup(ctx as never, (async () => ({})) as never)
      const models = [
        { providerID: "anthropic", id: "big", limit: { context: 1000000 } },
        { providerID: "anthropic", id: "small", limit: { context: 200000 } },
      ]
      for (const edit of modelEdits) {
        edit({
          list: () => models,
          update: (_p: string, id: string, fn: (m: unknown) => void) =>
            fn(models.find((m) => m.id === id)),
        })
      }
      assert.deepEqual(
        models.map((m) => m.limit.context),
        [400000, 200000],
      )
    } finally {
      resetConfigCache()
    }
  })

  it("has a stable id", () => {
    assert.equal(PLUGIN_ID, "claude-accounts")
  })
})
