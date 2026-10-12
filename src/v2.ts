/**
 * OpenCode 2 entry point.
 *
 * V2 replaced the plugin API: hooks are registered on domains instead of being
 * returned by key, and a provider can no longer be handed a custom `fetch`.
 * Rather than re-implement the request path -- credentials, betas, body and
 * stream rewriting, 401/429/prefill/long-context retries, rotation, quota
 * bookkeeping -- this runs the V1 plugin unchanged and adapts its hooks:
 *
 *   auth.loader().fetch          -> a loopback proxy the anthropic provider's
 *                                   baseURL points at
 *   chat.headers                 -> session hook "model.request"
 *   experimental.chat.system.*   -> session hooks context/compaction/generate/title
 *   config (account label)       -> provider transform (name) / model transform
 *   auth.loader (zero cost)      -> model transform
 *   auth.methods (switcher)      -> integration OAuth method
 *   tool                         -> tool transform
 *
 * There is one V1 plugin instance per V2 plugin instance, so the balancer,
 * timers and caches behave exactly as they did under V1.
 */
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import type { Plugin as V1Plugin } from "@opencode-ai/plugin"
import type { Plugin as V2Plugin } from "@opencode/plugin"
import { z } from "zod"

import { log } from "./logger.ts"

type Context = Parameters<V2Plugin.Plugin["setup"]>[0]
type V1Hooks = Awaited<ReturnType<V1Plugin>>
type ClaudeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export const PLUGIN_ID = "claude-accounts"
const PROVIDER_ID = "anthropic"
const UPSTREAM = "https://api.anthropic.com"

// Hop-by-hop and transport headers the proxy must not forward. fetch() decodes
// compressed bodies, so a forwarded content-encoding would describe bytes the
// client never receives.
const DROP_REQUEST = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "transfer-encoding",
])
const DROP_RESPONSE = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
])

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

/** Serve the V1 fetch on loopback so the native anthropic provider goes through it. */
async function startProxy(
  claudeFetch: ClaudeFetch,
): Promise<{ server: Server; baseURL: string }> {
  const server = createServer(async (req, res) => {
    const abort = new AbortController()
    res.on("close", () => {
      if (!res.writableFinished) abort.abort()
    })
    try {
      const raw = await readBody(req)
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined || DROP_REQUEST.has(key)) continue
        headers[key] = Array.isArray(value) ? value.join(", ") : value
      }
      const method = (req.method ?? "POST").toUpperCase()
      const response = await claudeFetch(`${UPSTREAM}${req.url ?? "/"}`, {
        method,
        headers,
        // A string, because the V1 path parses and rewrites string bodies only.
        body:
          method === "GET" || method === "HEAD"
            ? undefined
            : raw.toString("utf8"),
        signal: abort.signal,
      })
      const out: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        if (!DROP_RESPONSE.has(key)) out[key] = value
      })
      res.writeHead(response.status, out)
      if (!response.body) return void res.end()
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!res.write(value)) await new Promise((r) => res.once("drain", r))
      }
      res.end()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log("v2_proxy_error", { message })
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "api_error", message },
          }),
        )
      } else {
        res.destroy()
      }
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  server.unref()
  const { port } = server.address() as AddressInfo
  return { server, baseURL: `http://127.0.0.1:${port}/v1` }
}

/** The V1 switcher's select prompt, as a V2 form field. */
function accountForm(hooks: V1Hooks) {
  const method = hooks.auth?.methods?.[0] as
    | {
        prompts?: Array<{
          type: string
          key: string
          message: string
          options?: Array<{ label: string; value: string; hint?: string }>
        }>
      }
    | undefined
  const prompt = method?.prompts?.find((p) => p.type === "select")
  if (!prompt?.options?.length) return undefined
  return [
    {
      type: "string" as const,
      key: prompt.key,
      title: prompt.message,
      required: true,
      options: prompt.options.map((o) => ({
        value: o.value,
        label: o.label,
        ...(o.hint ? { description: o.hint } : {}),
      })),
    },
  ] as const
}

export async function setup(ctx: Context, v1: V1Plugin) {
  // Same inputs V1 received. The server has no TUI; toasts are logged instead
  // and the TUI plugin surfaces account state on its own.
  const shim = {
    directory: ctx.location.directory,
    worktree: ctx.location.project?.directory ?? ctx.location.directory,
    client: {
      tui: {
        showToast: async (input: {
          body?: { title?: string; message?: string }
        }) => {
          log("v2_toast_suppressed", {
            title: input?.body?.title,
            message: input?.body?.message,
          })
          return true
        },
      },
    },
  }
  const hooks = (await (
    v1 as unknown as (i: unknown, o: unknown) => ReturnType<V1Plugin>
  )(shim, ctx.options)) as V1Hooks

  // --- Request path --------------------------------------------------------
  let cleanupProxy: (() => void) | undefined
  const loaded = hooks.auth?.loader
    ? await hooks.auth.loader(async () => ({ type: "oauth" }) as never, {
        models: {},
      } as never)
    : undefined
  const claudeFetch = (loaded as { fetch?: ClaudeFetch } | undefined)?.fetch
  if (claudeFetch) {
    const { server, baseURL } = await startProxy(claudeFetch)
    cleanupProxy = () => server.close()
    log("v2_proxy_listening", { baseURL })
    await ctx.provider.transform((editor) => {
      editor.update(PROVIDER_ID, (provider) => {
        provider.settings = { ...provider.settings, baseURL }
      })
    })
  } else {
    log("v2_proxy_skipped", {
      reason: "no Claude credentials; anthropic left on its own auth",
    })
  }

  // --- Session hooks -------------------------------------------------------
  const chatHeaders = hooks["chat.headers"]
  if (chatHeaders) {
    await ctx.session.hook(
      "model.request",
      async (event) => {
        await chatHeaders(
          {
            sessionID: event.sessionID,
            agent: event.agent,
            model: { id: event.model.id, providerID: event.model.providerID },
          } as never,
          { headers: event.headers } as never,
        )
      },
      { providerID: PROVIDER_ID },
    )
  }

  const systemTransform = hooks["experimental.chat.system.transform"]
  if (systemTransform) {
    // V1 ran this for every model request, so register every request kind.
    const apply = async (event: {
      model: { providerID: string; id: string }
      system: Array<{ type: string; text?: string }>
    }) => {
      const before = event.system.map((p) =>
        p.type === "text" ? (p.text ?? "") : "",
      )
      const output = { system: [...before] }
      await systemTransform(
        {
          model: { providerID: event.model.providerID, id: event.model.id },
        } as never,
        output as never,
      )
      // V1 only ever prepends; carry the new entries over as text parts.
      const added = output.system.length - before.length
      if (added > 0) {
        event.system.unshift(
          ...output.system
            .slice(0, added)
            .map((text) => ({ type: "text", text })),
        )
      }
    }
    for (const kind of [
      "context",
      "compaction",
      "generate",
      "title",
    ] as const) {
      await ctx.session.hook(kind, apply as never, { providerID: PROVIDER_ID })
    }
  }

  // --- Provider and model presentation ------------------------------------
  if (claudeFetch) {
    // V1 zeroed model cost in the auth loader: the subscription pays, not tokens.
    await ctx.model.transform((editor) => {
      for (const model of editor.list(PROVIDER_ID)) {
        editor.update(String(model.providerID), String(model.id), (draft) => {
          draft.cost = draft.cost.map((tier) => ({
            ...tier,
            input: 0,
            output: 0,
            cache: { read: 0, write: 0 },
          })) as never
        })
      }
    })
  }

  if (hooks.config) {
    // The label is a start-up snapshot under V1 too; computed once, replayed cheaply.
    const fake = {
      provider: {
        [PROVIDER_ID]: {
          name: "Anthropic",
          models: {} as Record<string, { name?: string }>,
        },
      },
    }
    try {
      await hooks.config(fake as never)
    } catch {}
    const name = fake.provider[PROVIDER_ID].name
    if (name && name !== "Anthropic") {
      await ctx.provider.transform((editor) => {
        editor.update(PROVIDER_ID, (provider) => {
          provider.name = name
        })
      })
    }
  }

  // --- Account switcher ----------------------------------------------------
  const method = hooks.auth?.methods?.[0] as
    | {
        label: string
        authorize: (inputs?: Record<string, string>) => Promise<{
          instructions: string
          callback: () => Promise<{
            access: string
            refresh: string
            expires: number
          }>
        }>
      }
    | undefined
  let form = accountForm(hooks)
  if (method) {
    await ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: {
          id: "oauth",
          type: "oauth",
          label: method.label,
          ...(form ? { form } : {}),
        },
        authorize: async (answer) => {
          const inputs = Object.fromEntries(
            Object.entries(answer).map(([k, v]) => [k, String(v)]),
          )
          const result = await method.authorize(inputs)
          return {
            url: "",
            instructions: result.instructions,
            mode: "auto" as const,
            callback: result.callback().then((c) => ({
              type: "oauth" as const,
              methodID: "oauth" as never,
              access: c.access,
              refresh: c.refresh,
              expires: c.expires,
            })),
          }
        },
      })
    })
  }
  // The V1 prompts getter re-read accounts and quota on every open. V2 forms
  // are static per registration, so rebuild on an interval instead.
  const formTimer = setInterval(() => {
    try {
      form = accountForm(hooks)
      void ctx.integration.reload()
    } catch {}
  }, 60_000)
  formTimer.unref?.()

  // --- Tools ----------------------------------------------------------------
  const tools = hooks.tool as
    | Record<
        string,
        {
          description: string
          args: z.ZodRawShape
          execute: (args: unknown, context: unknown) => Promise<unknown>
        }
      >
    | undefined
  if (tools) {
    await ctx.tool.transform((editor) => {
      for (const [name, def] of Object.entries(tools)) {
        editor.add({
          name,
          description: def.description,
          input: z.object(def.args),
          execute: async (input: unknown, context: unknown) => {
            const result = await def.execute(input, context)
            return {
              content:
                typeof result === "string" ? result : JSON.stringify(result),
            }
          },
        } as never)
      }
    })
  }

  log("v2_setup_complete", {
    proxy: !!claudeFetch,
    tools: tools ? Object.keys(tools).length : 0,
    switcher: !!method,
  })

  return () => {
    clearInterval(formTimer)
    cleanupProxy?.()
  }
}
