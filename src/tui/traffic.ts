/**
 * Tool traffic: what every tool call put into the context, and what to change.
 *
 * OpenCode already records every tool call with its input and output, so nothing new
 * is captured here. A tool's output is paid more than once: it is read in full on the
 * next turn and then re-read from cache on every turn after that until compaction.
 * `carried` estimates that second cost, which is usually the larger one.
 *
 * Pure, like tokens.ts: the TUI hands in plain call records.
 */

import {
  BYTES_PER_TOKEN,
  type Composition,
  type GlobalTotals,
  type Row,
  type SessionTotals,
  si,
} from "./tokens.ts"

export type ToolCall = {
  tool: string
  /** Shell command, when the tool runs one. */
  command?: string
  outBytes: number
  /** Assistant turns after the one that made the call (session view only). */
  laterTurns?: number
}

const tok = (bytes: number) => Math.round(bytes / BYTES_PER_TOKEN)
const SHELLS = new Set(["bash", "shell"])

/**
 * Group key. Shell calls split by the program they ran, since `bash` alone hides
 * whether the bytes came from git, sqlite3 or a log dump. Leading `cd x &&` and
 * `VAR=value` are skipped; `rtk`-style wrappers keep their first argument.
 */
export function toolKey(call: Pick<ToolCall, "tool" | "command">): string {
  const tool = call.tool.startsWith("mcp_") ? call.tool.slice(4) : call.tool
  if (!SHELLS.has(tool.toLowerCase()) || !call.command) return tool
  const segment = call.command
    .split(/&&|;|\|\|/)
    .map((s) => s.trim())
    .find((s) => s && !/^cd\s/.test(s))
  const words = (segment ?? "")
    .split(/\s+/)
    .filter((w) => w && !/^\w+=/.test(w))
  const prog = (words[0] ?? "").split("/").pop() ?? ""
  if (!prog) return "shell"
  return prog === "rtk" || prog === "sudo" || prog === "npx"
    ? `$ ${prog} ${words[1] ?? ""}`.trim()
    : `$ ${prog}`
}

export type ToolStat = {
  key: string
  calls: number
  tokens: number
  avg: number
  max: number
  carried: number
}

const weightOf = (s: ToolStat) => s.tokens + s.carried

export type Traffic = {
  calls: number
  tokens: number
  carried: number
  top: ToolStat[]
}

export function traffic(calls: ToolCall[], topN = 5): Traffic {
  const by = new Map<string, ToolStat>()
  let tokens = 0
  let carried = 0
  for (const c of calls) {
    const t = tok(c.outBytes)
    // shortcut: assumes the output stays in context for every later turn; compaction
    // prunes old outputs, so this overstates long sessions. Use compaction times if it matters.
    const k = t * (c.laterTurns ?? 0)
    tokens += t
    carried += k
    const key = toolKey(c)
    const s = by.get(key) ?? {
      key,
      calls: 0,
      tokens: 0,
      avg: 0,
      max: 0,
      carried: 0,
    }
    s.calls++
    s.tokens += t
    s.max = Math.max(s.max, t)
    s.carried += k
    by.set(key, s)
  }
  const all = [...by.values()]
  for (const st of all) st.avg = Math.round(st.tokens / st.calls)
  return {
    calls: calls.length,
    tokens,
    carried,
    top: all.sort((a, b) => weightOf(b) - weightOf(a)).slice(0, topN),
  }
}

/**
 * Walk a session's messages in order and turn its tool parts into calls, counting how
 * many assistant turns followed each one.
 */
export function sessionCalls(
  messages: ReadonlyArray<{ id: string; role: string }>,
  partsOf: (messageID: string) => ReadonlyArray<unknown>,
): ToolCall[] {
  const assistants = messages.filter((m) => m.role === "assistant")
  const calls: ToolCall[] = []
  assistants.forEach((m, i) => {
    for (const raw of partsOf(m.id)) {
      const p = raw as {
        type?: string
        tool?: string
        state?: {
          status?: string
          output?: string
          input?: { command?: unknown }
        }
      }
      if (p?.type !== "tool" || !p.tool || p.state?.status !== "completed")
        continue
      calls.push({
        tool: p.tool,
        command:
          typeof p.state.input?.command === "string"
            ? p.state.input.command
            : undefined,
        outBytes: (p.state.output ?? "").length,
        laterTurns: assistants.length - 1 - i,
      })
    }
  })
  return calls
}

export function trafficRows(t: Traffic, carried: boolean): Row[] {
  if (t.calls === 0) return [{ label: "tools", value: "no calls yet" }]
  const rows: Row[] = [
    {
      label: "output",
      value: carried
        ? `~${si(t.tokens)} tok · ${t.calls} calls · re-read ~${si(t.carried)}`
        : `~${si(t.tokens)} tok · ${t.calls} calls`,
    },
  ]
  for (const s of t.top) {
    rows.push({
      label: `  ${s.key}`.slice(0, 12),
      value: `${s.calls}× ~${si(s.avg)} avg${carried && s.carried ? ` · ↻${si(s.carried)}` : ` · ~${si(s.tokens)}`}`,
      level: s.avg > 5_000 ? "warn" : "ok",
    })
  }
  return rows
}

export type HintInput = {
  traffic?: Traffic
  composition?: Composition
  session?: SessionTotals
  global?: GlobalTotals
  files?: InstructionFile[]
}

/**
 * What to change, cheapest-to-act-on first. Each hint names the thing to change and
 * its size, so the sidebar says "do X, saves ~N" and not just "this is big".
 */
export function hints(h: HintInput, max = 5): Row[] {
  const out: { weight: number; row: Row }[] = []
  const add = (
    weight: number,
    label: string,
    value: string,
    level: Row["level"] = "warn",
  ) => out.push({ weight, row: { label, value, level } })

  // Ranked first on purpose: deleting a duplicate is the cheapest fix there is.
  for (const d of duplicateInstructions(h.files ?? []))
    add(
      d.tokens * 10,
      "duplicate",
      `${d.paths[0]!.split("/").slice(-2).join("/")} loaded twice: ~${si(d.tokens)}/turn`,
    )
  const c = h.composition
  if (c) {
    if (c.instructions > 30_000)
      add(
        c.instructions,
        "instructions",
        `~${si(c.instructions)}/turn: dedupe AGENTS.md, move rules to skills`,
      )
    if (c.injected > 15_000)
      add(
        c.injected,
        "injected",
        `~${si(c.injected)} of reminders re-sent each turn`,
      )
    for (const g of c.toolGroups)
      if (g.tokens > 2_500)
        add(
          g.tokens,
          "schema",
          `${g.group} ~${si(g.tokens)}/turn: disable or trim`,
        )
  }
  const s = h.session
  if (s && s.turns > 0) {
    if (s.lastContext > 150_000)
      add(
        s.lastContext,
        "context",
        `${si(s.lastContext)}: compact or start fresh`,
        "critical",
      )
    const read = s.input + s.cacheRead + s.cacheWrite
    const cached = read > 0 ? s.cacheRead / read : 1
    if (read > 200_000 && cached < 0.8)
      add(
        read * (1 - cached),
        "cache",
        `${Math.round(cached * 100)}% hit: prefix changes between turns`,
      )
  }
  // Small outputs add up: in a long session the re-reads dwarf the outputs themselves.
  const tr = h.traffic
  if (tr && tr.carried > 5_000_000)
    add(
      tr.carried,
      "re-reads",
      `tool output re-read ~${si(tr.carried)}: compact sooner`,
    )
  for (const t of tr?.top ?? []) {
    if (t.calls >= 3 && t.avg > 5_000)
      add(
        t.carried || t.tokens,
        t.key.slice(0, 12),
        `~${si(t.avg)}/call: filter or sandbox output`,
      )
    else if (t.max > 20_000)
      add(
        t.max,
        t.key.slice(0, 12),
        `one call ~${si(t.max)}: use limits/offset`,
      )
  }
  const g = h.global
  if (g && g.subagentShare > 0.4)
    add(
      g.read * g.subagentShare,
      "subagents",
      `${Math.round(g.subagentShare * 100)}% of reads: brief them tighter`,
    )

  if (out.length === 0)
    return [{ label: "hints", value: "✓ nothing stands out", level: "ok" }]
  return out
    .sort((a, b) => b.weight - a.weight)
    .slice(0, max)
    .map((o) => o.row)
}

export type InstructionFile = { path: string; bytes: number; hash: string }

/**
 * Instruction files whose content is loaded more than once. A global AGENTS.md that
 * symlinks to a repo, opened from a worktree of that repo, is the usual cause.
 */
export function duplicateInstructions(
  files: InstructionFile[],
): { paths: string[]; tokens: number }[] {
  const by = new Map<string, InstructionFile[]>()
  for (const f of files) by.set(f.hash, [...(by.get(f.hash) ?? []), f])
  return [...by.values()]
    .filter((g) => g.length > 1)
    .map((g) => ({
      paths: g.map((f) => f.path),
      tokens: tok(g[0]!.bytes) * (g.length - 1),
    }))
}

export type ReportInput = HintInput & {
  directory: string
  files: InstructionFile[]
  sections: { title: string; rows: Row[] }[]
}

/** The message /optimize sends: the numbers, then a precise ask. */
export function optimizeReport(r: ReportInput): string {
  const lines = [
    `Token optimisation report for this OpenCode setup (directory: ${r.directory}).`,
    "Token counts are estimates (bytes/3.7) unless they come from the session store.",
    "",
    "Instruction files loaded at session start:",
    ...r.files.map((f) => `- ${f.path}: ~${si(tok(f.bytes))} tok`),
  ]
  for (const d of duplicateInstructions(r.files))
    lines.push(
      `- DUPLICATE content, ~${si(d.tokens)} tok wasted per turn: ${d.paths.join(" == ")}`,
    )
  for (const s of r.sections) {
    lines.push("", `${s.title}:`)
    for (const row of s.rows)
      lines.push(
        `- ${row.label.trim()}: ${row.value}${row.level && row.level !== "ok" ? ` [${row.level}]` : ""}`,
      )
  }
  lines.push(
    "",
    "Task: propose concrete fixes ranked by tokens saved per turn. For each: the exact file or",
    "config to change, the change, the estimated saving, and the risk. Check the files above",
    "before proposing. Do NOT apply anything until I approve.",
  )
  return lines.join("\n")
}
