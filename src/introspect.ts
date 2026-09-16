/**
 * What is actually being sent to Anthropic, structurally.
 *
 * The request body is the only place the real prompt exists: OpenCode assembles
 * it from agent instructions, rules, skills and tool schemas, and by the time it
 * reaches the wire nothing on disk tells you what the total looks like or which
 * file contributed which part. This records the SHAPE of each request so that
 * question can be answered afterwards — which system blocks, how large, which
 * tools, how much of it is cacheable.
 *
 * Off by default, and deliberately so. A request body contains the user's
 * conversation, so:
 *
 *   - `shape` records sizes, hashes and an 80-character head of each system
 *     block. Message CONTENT is never recorded at any level — only role and
 *     size — because attribution needs the system prompt, not the conversation.
 *   - `full` adds the complete system text, which is what makes attribution to a
 *     source file possible. Still no message content.
 *
 * The capture is written beside the other local state and is never committed.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * How much of a request to record.
 *
 *   off       nothing
 *   shape     sizes, hashes, an 80-char head. No text of any kind.
 *   full      + the system text, which is what allows a block to be traced to
 *             the file that produced it. Still no message content.
 *   messages  + the message content itself. This is the conversation, verbatim,
 *             on disk in plain text. Intended to be switched on for a few
 *             minutes to answer a specific question and switched off again —
 *             the config comment and the README both say so, and nothing turns
 *             it on by default.
 */
export type CaptureLevel = "off" | "shape" | "full" | "messages"

export type SystemBlock = {
  index: number
  bytes: number
  /** Stable identity for the block, so repeats across requests are countable. */
  sha1: string
  /** First 80 characters, enough to recognise it by eye. */
  head: string
  /** Whether Anthropic was asked to cache this block. */
  cached: boolean
  /** Only at level "full": the whole block, for source attribution. */
  text?: string
}

export type ToolShape = {
  name: string
  /** Bytes of the JSON schema, which is what the description actually costs. */
  bytes: number
  descriptionBytes: number
}

export type RequestShape = {
  timestamp: string
  created_at: number
  model: string
  sessionId: string | null
  /** Total body size on the wire. */
  bytes: number
  system: SystemBlock[]
  systemBytes: number
  tools: ToolShape[]
  toolBytes: number
  /** Role and size always; `content` only at level "messages". */
  messages: Array<{ role: string; bytes: number; content?: unknown }>
  messageBytes: number
  cachedBytes: number
}

const MAX_BYTES = 8 * 1024 * 1024

export function capturePath(): string {
  return join(
    homedir(),
    ".local",
    "share",
    "opencode",
    "claude-auth-requests.jsonl",
  )
}

const sha1 = (s: string) =>
  createHash("sha1").update(s).digest("hex").slice(0, 12)
const bytes = (v: unknown) =>
  typeof v === "string"
    ? Buffer.byteLength(v)
    : Buffer.byteLength(JSON.stringify(v ?? ""))

/**
 * Anthropic accepts `system` as a string or as an array of blocks. Both are
 * normalised here so the analysis does not have to care which shape arrived.
 */
function systemBlocks(system: unknown, level: CaptureLevel): SystemBlock[] {
  if (typeof system === "string") {
    return [
      {
        index: 0,
        bytes: Buffer.byteLength(system),
        sha1: sha1(system),
        head: system.slice(0, 80).replace(/\s+/g, " "),
        cached: false,
        ...(level === "full" ? { text: system } : {}),
      },
    ]
  }
  if (!Array.isArray(system)) return []
  return system.map((raw, index) => {
    const block = (raw ?? {}) as { text?: string; cache_control?: unknown }
    const text =
      typeof block.text === "string" ? block.text : JSON.stringify(raw)
    return {
      index,
      bytes: Buffer.byteLength(text),
      sha1: sha1(text),
      head: text.slice(0, 80).replace(/\s+/g, " "),
      cached: block.cache_control !== undefined,
      ...(level === "full" ? { text } : {}),
    }
  })
}

function toolShapes(tools: unknown): ToolShape[] {
  if (!Array.isArray(tools)) return []
  return tools.map((raw) => {
    const t = (raw ?? {}) as { name?: string; description?: string }
    return {
      name: typeof t.name === "string" ? t.name : "(unnamed)",
      bytes: bytes(raw),
      descriptionBytes:
        typeof t.description === "string"
          ? Buffer.byteLength(t.description)
          : 0,
    }
  })
}

/**
 * Describe one request. Returns undefined when capture is off or the body is
 * not the JSON we expect, so the caller can stay a single guarded call.
 */
export function describeRequest(
  bodyStr: string | undefined,
  level: CaptureLevel,
  sessionId: string | null,
): RequestShape | undefined {
  if (level === "off" || !bodyStr) return undefined
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(bodyStr) as Record<string, unknown>
  } catch {
    return undefined
  }

  const system = systemBlocks(parsed.system, level)
  const tools = toolShapes(parsed.tools)
  const rawMessages = Array.isArray(parsed.messages) ? parsed.messages : []
  const messages = rawMessages.map((m) => {
    const msg = (m ?? {}) as { role?: string; content?: unknown }
    const entry: { role: string; bytes: number; content?: unknown } = {
      role: typeof msg.role === "string" ? msg.role : "?",
      bytes: bytes(m),
    }
    // Only at the level that exists to record it. Every other level stops at
    // role and size, so turning capture on to measure prompt size never writes
    // the conversation to disk as a side effect.
    if (level === "messages") entry.content = msg.content
    return entry
  })

  const now = Date.now()
  return {
    timestamp: new Date(now).toISOString(),
    created_at: now,
    model: typeof parsed.model === "string" ? parsed.model : "unknown",
    sessionId,
    bytes: Buffer.byteLength(bodyStr),
    system,
    systemBytes: system.reduce((n, b) => n + b.bytes, 0),
    tools,
    toolBytes: tools.reduce((n, t) => n + t.bytes, 0),
    messages,
    messageBytes: messages.reduce((n, m) => n + m.bytes, 0),
    cachedBytes: system
      .filter((b) => b.cached)
      .reduce((n, b) => n + b.bytes, 0),
  }
}

/** Append one shape. Never throws: this runs on the request path. */
export function recordShape(
  shape: RequestShape,
  path: string = capturePath(),
): void {
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    try {
      if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`)
    } catch {
      // no file yet, or another process rotated it first
    }
    appendFileSync(path, `${JSON.stringify(shape)}\n`, "utf-8")
  } catch {
    // Non-fatal by design.
  }
}

/** Read captured shapes back. Missing or malformed lines are skipped. */
export function readShapeFile(path: string = capturePath()): RequestShape[] {
  const out: RequestShape[] = []
  let text: string
  try {
    text = readFileSync(path, "utf-8")
  } catch {
    return out
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as RequestShape)
    } catch {
      continue
    }
  }
  return out
}

export function isCaptureLevel(v: unknown): v is CaptureLevel {
  return v === "off" || v === "shape" || v === "full" || v === "messages"
}
