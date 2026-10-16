/**
 * Where the tokens go: this session, every session, and what one request is made of.
 *
 * Pure, like chip.ts and forecast.ts. The TUI feeds it three things it can read:
 *  - the assistant messages of the session on screen (real token counts per turn),
 *  - one row per session from OpenCode's store (real totals, for the global view),
 *  - the newest captured request shape (sizes of system blocks, tool schemas and
 *    messages), which is the only place the prompt's COMPOSITION exists.
 *
 * Cache reads dominate a coding agent's bill: the same instructions, rules and
 * tool schemas are re-sent on every turn, so the size of that fixed prefix times
 * the number of turns is the number worth shrinking. That is what `fixed` shows.
 */

export type TurnTokens = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

export type SessionTotals = TurnTokens & {
  turns: number
  /** Tokens the model read per turn, on average (input + cache read + write). */
  avgContext: number
  /** The latest turn's context, which is what the next turn starts from. */
  lastContext: number
}

const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)

/** Sum the assistant turns of one session. Accepts OpenCode's message objects. */
export function sessionTotals(messages: ReadonlyArray<unknown>): SessionTotals {
  const t: SessionTotals = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
    avgContext: 0,
    lastContext: 0,
  }
  for (const raw of messages) {
    const m = raw as {
      role?: string
      cost?: number
      tokens?: {
        input?: number
        output?: number
        reasoning?: number
        cache?: { read?: number; write?: number }
      }
    }
    if (m?.role !== "assistant" || !m.tokens) continue
    const ctx =
      n(m.tokens.input) + n(m.tokens.cache?.read) + n(m.tokens.cache?.write)
    if (ctx === 0 && n(m.tokens.output) === 0) continue // aborted turn: nothing was billed
    t.turns++
    t.input += n(m.tokens.input)
    t.output += n(m.tokens.output)
    t.reasoning += n(m.tokens.reasoning)
    t.cacheRead += n(m.tokens.cache?.read)
    t.cacheWrite += n(m.tokens.cache?.write)
    t.cost += n(m.cost)
    t.lastContext = ctx
  }
  t.avgContext =
    t.turns > 0
      ? Math.round((t.input + t.cacheRead + t.cacheWrite) / t.turns)
      : 0
  return t
}

export type SessionRow = {
  id: string
  title: string
  parentId?: string | null
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

export type GlobalTotals = {
  sessions: number
  subagents: number
  read: number
  output: number
  cost: number
  /** Share of all tokens read by subagent sessions. */
  subagentShare: number
  top: { title: string; read: number; share: number; subagent: boolean }[]
}

const readOf = (r: SessionRow) => n(r.input) + n(r.cacheRead) + n(r.cacheWrite)

export function globalTotals(rows: SessionRow[], topN = 3): GlobalTotals {
  const read = rows.reduce((s, r) => s + readOf(r), 0)
  const sub = rows.filter((r) => r.parentId)
  const subRead = sub.reduce((s, r) => s + readOf(r), 0)
  return {
    sessions: rows.length,
    subagents: sub.length,
    read,
    output: rows.reduce((s, r) => s + n(r.output), 0),
    cost: rows.reduce((s, r) => s + n(r.cost), 0),
    subagentShare: read > 0 ? subRead / read : 0,
    top: [...rows]
      .sort((a, b) => readOf(b) - readOf(a))
      .slice(0, topN)
      .map((r) => ({
        title: r.title,
        read: readOf(r),
        share: read > 0 ? readOf(r) / read : 0,
        subagent: Boolean(r.parentId),
      })),
  }
}

/** ~3.7 bytes per token for English prose and JSON; labelled as an estimate. */
export const BYTES_PER_TOKEN = 3.7
const tok = (bytes: number) => Math.round(bytes / BYTES_PER_TOKEN)

export type ShapeLike = {
  systemBytes: number
  toolBytes: number
  messageBytes: number
  system: { bytes: number; head: string }[]
  tools: { name: string; bytes: number }[]
  messages?: { role: string; bytes: number }[]
}

export type Composition = {
  system: number
  tools: number
  messages: number
  /**
   * OpenCode 2 sends AGENTS.md, rules and the skill list as the FIRST user message,
   * not as `system`, so the system field alone hides the real fixed prefix.
   */
  instructions: number
  /** System-role messages injected mid-conversation (reminders, re-announced skills). */
  injected: number
  conversation: number
  /** The part re-sent unchanged on every turn: system + tools + instructions. */
  fixed: number
  blocks: { head: string; tokens: number }[]
  toolGroups: { group: string; tokens: number; count: number }[]
}

/**
 * Tool names group by their MCP server prefix (`pelico-notion_search` -> `pelico-notion`);
 * built-ins stand alone under their own name.
 */
export function toolGroup(name: string): string {
  // OpenCode 2 prefixes every tool with `mcp_`, which would lump them all together.
  const bare = name.startsWith("mcp_") ? name.slice(4) : name
  const i = bare.indexOf("_")
  return i > 0 ? bare.slice(0, i) : bare
}

export function composition(shape: ShapeLike, topN = 3): Composition {
  const groups = new Map<string, { tokens: number; count: number }>()
  for (const t of shape.tools ?? []) {
    const g = groups.get(toolGroup(t.name)) ?? { tokens: 0, count: 0 }
    g.tokens += tok(t.bytes)
    g.count++
    groups.set(toolGroup(t.name), g)
  }
  const msgs = shape.messages ?? []
  const instructions = msgs[0]?.role === "user" ? msgs[0].bytes : 0
  const injected = msgs
    .filter((m) => m.role === "system")
    .reduce((s, m) => s + m.bytes, 0)
  return {
    system: tok(shape.systemBytes),
    tools: tok(shape.toolBytes),
    messages: tok(shape.messageBytes),
    instructions: tok(instructions),
    injected: tok(injected),
    conversation: tok(
      Math.max(0, shape.messageBytes - instructions - injected),
    ),
    fixed: tok(shape.systemBytes + shape.toolBytes + instructions),
    // Tiny blocks (billing header, one-line identity) are noise in a sidebar.
    blocks: [...(shape.system ?? [])]
      .filter((b) => b.bytes >= 1_000)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, topN)
      .map((b) => ({ head: b.head.trim(), tokens: tok(b.bytes) })),
    toolGroups: [...groups.entries()]
      .map(([group, g]) => ({ group, tokens: g.tokens, count: g.count }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, topN),
  }
}

/** 1234 -> "1.2k", 3_024_226_301 -> "3.0G". */
export function si(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}G`
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`
  return String(Math.round(v))
}

const pct = (f: number) => `${Math.round(f * 100)}%`

export type Row = {
  label: string
  value: string
  level?: "ok" | "warn" | "critical"
}

/** Sidebar rows for the session on screen. */
export function sessionRows(s: SessionTotals): Row[] {
  if (s.turns === 0) return [{ label: "session", value: "no turns yet" }]
  const read = s.input + s.cacheRead + s.cacheWrite
  return [
    { label: "turns", value: `${s.turns} · $${s.cost.toFixed(2)}` },
    {
      label: "read",
      value: `${si(read)} (${pct(read > 0 ? s.cacheRead / read : 0)} cached)`,
    },
    { label: "out", value: si(s.output + s.reasoning) },
    // The context the next turn starts from; it grows with the conversation and is what
    // compaction would cut.
    {
      label: "context",
      value: `${si(s.lastContext)} now · ${si(s.avgContext)} avg`,
      level: s.lastContext > 150_000 ? "warn" : "ok",
    },
  ]
}

export function globalRows(g: GlobalTotals, window: string): Row[] {
  const rows: Row[] = [
    {
      label: window,
      value: `${si(g.read)} read · ${si(g.output)} out · $${g.cost.toFixed(0)}`,
    },
    {
      label: "sessions",
      value: `${g.sessions} (${g.subagents} subagents = ${pct(g.subagentShare)})`,
    },
  ]
  for (const t of g.top) {
    rows.push({
      label: `  ${pct(t.share)}`,
      value: `${t.subagent ? "↳ " : ""}${t.title.slice(0, 28)}`,
    })
  }
  return rows
}

export function compositionRows(c: Composition): Row[] {
  const total = c.system + c.tools + c.messages
  const share = (v: number) => (total > 0 ? pct(v / total) : "-")
  const rows: Row[] = [
    { label: "total", value: `~${si(total)} tok` },
    {
      label: "fixed/turn",
      value: `~${si(c.fixed)} (instr+tools)`,
      level: c.fixed > 40_000 ? "warn" : "ok",
    },
    {
      label: "instructions",
      value: `~${si(c.instructions)} · ${share(c.instructions)}`,
      level: c.instructions > 30_000 ? "warn" : "ok",
    },
    { label: "tools", value: `~${si(c.tools)} · ${share(c.tools)}` },
    {
      label: "injected",
      value: `~${si(c.injected)} · ${share(c.injected)}`,
      level: c.injected > 20_000 ? "warn" : "ok",
    },
    {
      label: "conversation",
      value: `~${si(c.conversation)} · ${share(c.conversation)}`,
    },
  ]
  if (c.system > 0)
    rows.splice(3, 0, {
      label: "system",
      value: `~${si(c.system)} · ${share(c.system)}`,
    })
  for (const b of c.blocks)
    rows.push({ label: `  ~${si(b.tokens)}`, value: b.head.slice(0, 30) })
  for (const g of c.toolGroups)
    rows.push({
      label: `  ~${si(g.tokens)}`,
      value: `${g.group} (${g.count} tools)`,
    })
  return rows
}

const BLOCKS = "▁▂▃▄▅▆▇█"

/**
 * A one-line chart. Longer series are averaged into `width` buckets so the newest
 * values stay on the right; zero draws as the lowest block, so gaps still show.
 */
export function sparkline(values: number[], width = 24): string {
  if (values.length === 0) return ""
  const step = Math.max(1, values.length / width)
  const buckets: number[] = []
  for (let i = 0; i < values.length; i += step) {
    const slice = values.slice(Math.floor(i), Math.floor(i + step))
    buckets.push(slice.reduce((s, v) => s + v, 0) / slice.length)
  }
  const max = Math.max(...buckets)
  if (max <= 0) return BLOCKS[0]!.repeat(buckets.length)
  return buckets
    .map(
      (v) =>
        BLOCKS[
          Math.min(BLOCKS.length - 1, Math.floor((v / max) * BLOCKS.length))
        ],
    )
    .join("")
}

/** Context size of each billed assistant turn, oldest first. */
export function contextSeries(messages: ReadonlyArray<unknown>): number[] {
  const out: number[] = []
  for (const raw of messages) {
    const m = raw as {
      role?: string
      tokens?: {
        input?: number
        output?: number
        cache?: { read?: number; write?: number }
      }
    }
    if (m?.role !== "assistant" || !m.tokens) continue
    const ctx =
      n(m.tokens.input) + n(m.tokens.cache?.read) + n(m.tokens.cache?.write)
    if (ctx > 0) out.push(ctx)
  }
  return out
}

/** Tokens read per calendar day for the last `days` days, oldest first. */
export function dailySeries(
  rows: {
    updated: number
    input: number
    cacheRead: number
    cacheWrite: number
  }[],
  now: number,
  days = 7,
): number[] {
  const out: number[] = Array.from({ length: days }, () => 0)
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  for (const r of rows) {
    const ago = Math.floor(
      (today.getTime() + 86_400_000 - 1 - r.updated) / 86_400_000,
    )
    if (ago >= 0 && ago < days)
      out[days - 1 - ago]! += n(r.input) + n(r.cacheRead) + n(r.cacheWrite)
  }
  return out
}

export function chartRows(context: number[], daily: number[]): Row[] {
  const rows: Row[] = []
  if (context.length > 1)
    rows.push({
      label: "context",
      value: `${sparkline(context)} ${si(context[context.length - 1]!)}`,
      level: context[context.length - 1]! > 150_000 ? "warn" : "ok",
    })
  if (daily.some((v) => v > 0))
    rows.push({
      label: "7d read",
      value: `${sparkline(daily, 7)} ${si(daily[daily.length - 1]!)} today`,
    })
  return rows
}
