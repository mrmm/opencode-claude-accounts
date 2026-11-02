import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  createUsageParser,
  parseNonStreamUsage,
  teeUsage,
  type UsageTokens,
} from "./sse-usage.ts"

const messageStart = (usage: Record<string, unknown>) =>
  `event: message_start\ndata: ${JSON.stringify({
    type: "message_start",
    message: { usage },
  })}\n\n`

const messageDelta = (output: number) =>
  `event: message_delta\ndata: ${JSON.stringify({
    type: "message_delta",
    usage: { output_tokens: output },
  })}\n\n`

const sampleStream =
  messageStart({
    input_tokens: 100,
    output_tokens: 1,
    cache_read_input_tokens: 4000,
    cache_creation_input_tokens: 200,
  }) +
  "event: content_block_start\ndata: {}\n\n" +
  messageDelta(512)

const feed = (parser: ReturnType<typeof createUsageParser>, text: string) => {
  parser.push(text)
  parser.end()
  return parser.result()
}

describe("createUsageParser", () => {
  it("parses input from message_start and output from message_delta", () => {
    const u = feed(createUsageParser(), sampleStream)!
    assert.equal(u.input, 100)
    assert.equal(u.cacheRead, 4000)
    assert.equal(u.cacheWrite, 200)
    assert.equal(u.output, 512) // delta wins over the 1 in message_start
  })

  it("splits 5m and 1h cache writes when cache_creation is present", () => {
    const u = feed(
      createUsageParser(),
      messageStart({
        input_tokens: 10,
        cache_creation_input_tokens: 999,
        cache_creation: {
          ephemeral_5m_input_tokens: 30,
          ephemeral_1h_input_tokens: 70,
        },
      }) + messageDelta(5),
    )!
    assert.equal(u.cacheWrite, 30)
    assert.equal(u.cacheWrite1h, 70)
  })

  it("is robust to a chunk split anywhere, including inside a JSON line", () => {
    for (const splitAt of [0, 10, 40, 80, sampleStream.length - 1]) {
      const parser = createUsageParser()
      parser.push(sampleStream.slice(0, splitAt))
      parser.push(sampleStream.slice(splitAt))
      parser.end()
      const u = parser.result()!
      assert.equal(u.input, 100, `split at ${splitAt}`)
      assert.equal(u.output, 512, `split at ${splitAt}`)
      assert.equal(u.cacheRead, 4000, `split at ${splitAt}`)
    }
  })

  it("survives byte-by-byte delivery", () => {
    const parser = createUsageParser()
    for (const ch of sampleStream) parser.push(ch)
    parser.end()
    const u = parser.result()!
    assert.equal(u.input, 100)
    assert.equal(u.output, 512)
  })

  it("returns null when no usage event appeared", () => {
    assert.equal(feed(createUsageParser(), "event: ping\ndata: {}\n\n"), null)
  })

  it("skips [DONE] and non-JSON data lines without throwing", () => {
    const u = feed(
      createUsageParser(),
      messageStart({ input_tokens: 7 }) + "data: [DONE]\n\n",
    )!
    assert.equal(u.input, 7)
  })
})

describe("parseNonStreamUsage", () => {
  it("reads usage from a single JSON object", () => {
    const u = parseNonStreamUsage(
      JSON.stringify({
        usage: {
          input_tokens: 50,
          output_tokens: 80,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 20,
        },
      }),
    )!
    assert.equal(u.input, 50)
    assert.equal(u.output, 80)
    assert.equal(u.cacheRead, 10)
    assert.equal(u.cacheWrite, 20)
  })

  it("returns null on a body with no usage and on garbage", () => {
    assert.equal(parseNonStreamUsage(JSON.stringify({ x: 1 })), null)
    assert.equal(parseNonStreamUsage("not json"), null)
  })
})

describe("teeUsage", () => {
  const streamOf = (chunks: string[]): Response => {
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c))
        controller.close()
      },
    })
    return new Response(body, { status: 200 })
  }

  const drain = async (res: Response): Promise<string> => {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let out = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      out += decoder.decode(value, { stream: true })
    }
    return out
  }

  it("passes every byte through unchanged and reports usage after drain", async () => {
    let seen: UsageTokens | null = null
    const chunks = [sampleStream.slice(0, 30), sampleStream.slice(30)]
    const teed = teeUsage(streamOf(chunks), (u) => {
      seen = u
    })
    const body = await drain(teed)
    assert.equal(body, sampleStream)
    assert.ok(seen)
    assert.equal(seen!.input, 100)
    assert.equal(seen!.output, 512)
  })

  it("reports null usage for a body with no usage events", async () => {
    let fired = false
    let seen: UsageTokens | null = { ...({} as UsageTokens) }
    const teed = teeUsage(streamOf(["data: {}\n\n"]), (u) => {
      fired = true
      seen = u
    })
    await drain(teed)
    assert.ok(fired)
    assert.equal(seen, null)
  })

  it("fires exactly once on cancel", async () => {
    let calls = 0
    const teed = teeUsage(streamOf([sampleStream]), () => {
      calls += 1
    })
    await teed.body!.cancel("done")
    assert.equal(calls, 1)
  })
})
