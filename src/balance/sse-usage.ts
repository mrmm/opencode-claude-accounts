/**
 * Token usage, read off the response without touching it.
 *
 * Every Anthropic header already tells us an account's utilisation percentage,
 * but not the tokens behind it: a cache read is a fifth the price of a write and
 * a write is free to read later, so two requests at the same utilisation can
 * cost wildly different amounts. The token counts live only in the response —
 * `message_start.message.usage` for the input side and the final
 * `message_delta.usage.output_tokens` for the output — and a streamed response
 * delivers them split across arbitrary byte chunks.
 *
 * So this is a decode-only parser. It never holds the body: it is fed whatever
 * chunks arrive, reassembles SSE lines across chunk boundaries, and remembers
 * only the usage numbers. The side that passes bytes to the client is a thin
 * tee that calls `push` on the way through and never waits on it — the parser
 * must not be able to stall, corrupt or delay the stream it reads.
 */

/** Token counts for one request. All fields default to 0 when absent. */
export type UsageTokens = {
  /** Uncached input tokens — billed at the input rate. */
  input: number
  output: number
  /** Cache hits — billed at ~0.1x, and the number we want to maximise. */
  cacheRead: number
  /** 5-minute cache writes — billed at 1.25x. */
  cacheWrite: number
  /** 1-hour cache writes — billed at 2x. Separate because the TTL differs. */
  cacheWrite1h: number
}

export function emptyUsage(): UsageTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }
}

type RawUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
}

const num = (v: unknown): number => (typeof v === "number" ? v : 0)

/**
 * Fold one `usage` object into the accumulator.
 *
 * `message_start` carries the input side (and sometimes an output_tokens of 1);
 * `message_delta` carries the final output_tokens and nothing else. So input
 * fields are taken when present and output_tokens always overwrites — the delta
 * is the authoritative final count, and a 1 from message_start must not win.
 */
function applyUsage(acc: UsageTokens, u: RawUsage): void {
  if (u.input_tokens !== undefined) acc.input = num(u.input_tokens)
  if (u.cache_read_input_tokens !== undefined)
    acc.cacheRead = num(u.cache_read_input_tokens)

  // Prefer the broken-out cache_creation when the provider sends it (it splits
  // 5m from 1h); fall back to the flat total as a 5m write otherwise.
  const cc = u.cache_creation
  if (
    cc &&
    (cc.ephemeral_5m_input_tokens !== undefined ||
      cc.ephemeral_1h_input_tokens !== undefined)
  ) {
    acc.cacheWrite = num(cc.ephemeral_5m_input_tokens)
    acc.cacheWrite1h = num(cc.ephemeral_1h_input_tokens)
  } else if (u.cache_creation_input_tokens !== undefined) {
    acc.cacheWrite = num(u.cache_creation_input_tokens)
  }

  if (u.output_tokens !== undefined) acc.output = num(u.output_tokens)
}

export type UsageParser = {
  /** Feed a chunk of body text. Safe across arbitrary splits. */
  push(chunk: string): void
  /** Flush any complete-but-unterminated final line. */
  end(): void
  /** The usage seen so far, or null if no usage field has appeared yet. */
  result(): UsageTokens | null
}

/**
 * A streaming SSE usage parser.
 *
 * SSE frames are `data: <json>\n`. A chunk can split one anywhere — mid-JSON,
 * mid-word — so lines are reassembled in a buffer and only parsed once newline-
 * terminated. A `data:` line that is not JSON (`[DONE]`, a comment) is skipped
 * silently; this must never throw, because it runs on the request path.
 */
export function createUsageParser(): UsageParser {
  const acc = emptyUsage()
  let seen = false
  let buffer = ""

  const consumeLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed.startsWith("data:")) return
    const payload = trimmed.slice(5).trim()
    if (!payload || payload === "[DONE]") return
    let obj: { type?: string; usage?: RawUsage; message?: { usage?: RawUsage } }
    try {
      obj = JSON.parse(payload)
    } catch {
      return
    }
    const usage = obj.message?.usage ?? obj.usage
    if (usage && typeof usage === "object") {
      seen = true
      applyUsage(acc, usage)
    }
  }

  return {
    push(chunk: string): void {
      buffer += chunk
      let nl = buffer.indexOf("\n")
      while (nl !== -1) {
        consumeLine(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf("\n")
      }
    },
    end(): void {
      if (buffer) {
        consumeLine(buffer)
        buffer = ""
      }
    },
    result(): UsageTokens | null {
      return seen ? { ...acc } : null
    },
  }
}

/**
 * Pull usage out of a non-streamed JSON response body.
 *
 * The Messages API answers a non-stream request with a single JSON object whose
 * `usage` carries the same fields the stream splits across two events. Returns
 * null on anything that is not that shape, so the caller stays one guarded call.
 */
export function parseNonStreamUsage(bodyStr: string): UsageTokens | null {
  let obj: { usage?: RawUsage }
  try {
    obj = JSON.parse(bodyStr)
  } catch {
    return null
  }
  if (!obj.usage || typeof obj.usage !== "object") return null
  const acc = emptyUsage()
  applyUsage(acc, obj.usage)
  return acc
}

/**
 * Pass a streamed response through unchanged while reading its usage.
 *
 * A tee, not a transform: the bytes the client receives are exactly the bytes
 * the server sent, enqueued as they arrive. The parser is fed a copy and
 * `onUsage` fires once the stream ends, with whatever usage was seen (null if
 * none). Errors while reading propagate to the client stream as they would
 * without the tee; the usage callback is best-effort and never blocks a byte.
 *
 * Returns a new Response wrapping the teed stream. Kept here beside the parser
 * because it is the parser's only intended caller and is a thin shell over it.
 */
export function teeUsage(
  response: Response,
  onUsage: (usage: UsageTokens | null) => void,
): Response {
  if (!response.body) {
    onUsage(null)
    return response
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parser = createUsageParser()
  let fired = false
  const fire = (): void => {
    if (fired) return
    fired = true
    try {
      parser.end()
      onUsage(parser.result())
    } catch {
      // Telemetry must never break the response.
    }
  }

  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          fire()
          controller.close()
          return
        }
        if (value) {
          controller.enqueue(value)
          try {
            parser.push(decoder.decode(value, { stream: true }))
          } catch {
            // A decode or parse fault must not stop the passthrough.
          }
        }
      } catch (err) {
        // The upstream read failed (aborted, reset). Report what we have and
        // surface the error to the client exactly as it would have been.
        fire()
        controller.error(err)
      }
    },
    cancel(reason) {
      fire()
      return reader.cancel(reason)
    },
  })

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
