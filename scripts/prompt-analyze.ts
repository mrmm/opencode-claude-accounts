/**
 * What the prompt is made of, and where each part came from.
 *
 *   pnpm prompt                     latest request
 *   pnpm prompt -- --all            every captured request, aggregated
 *   pnpm prompt -- --sources ~/dir  extra roots to attribute against
 *
 * The request body is the only place the real prompt exists. OpenCode assembles
 * it from agent instructions, rules, skills and tool schemas, and nothing on
 * disk shows the total or which file contributed which part — so a prompt grows
 * by accretion and no single edit looks responsible.
 *
 * This reads the capture written by `captureRequests` and answers three things:
 * how large each system block is, which file on disk it came from, and what the
 * tool schemas cost. Attribution works by matching each block's text against
 * candidate files; at capture level "shape" there is no text to match, so it
 * reports sizes only and says so.
 *
 * Sizes are bytes. Token counts are an estimate at ~3.7 bytes/token for English
 * prose and are labelled as such — the exact number is Anthropic's to compute.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { extname, join, relative } from "node:path"

import { capturePath, type RequestShape } from "../dist/introspect.js"

const args = process.argv.slice(2)
const all = args.includes("--all")
const extraRoots = args
  .map((a, i) => (a === "--sources" ? args[i + 1] : undefined))
  .filter((v): v is string => !!v)

const BYTES_PER_TOKEN = 3.7
const tok = (b: number) =>
  `~${Math.round(b / BYTES_PER_TOKEN).toLocaleString()}t`
const kb = (b: number) => `${(b / 1024).toFixed(1)}K`

function load(): RequestShape[] {
  const out: RequestShape[] = []
  for (const p of [`${capturePath()}.1`, capturePath()]) {
    let text: string
    try {
      text = readFileSync(p, "utf-8")
    } catch {
      continue
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as RequestShape)
      } catch {
        continue
      }
    }
  }
  return out
}

/** Files a system block could plausibly have come from. */
function candidates(): string[] {
  const roots = [
    join(homedir(), ".config", "opencode"),
    join(homedir(), ".claude"),
    join(homedir(), ".agents"),
    process.cwd(),
    ...extraRoots,
  ]
  const wanted = new Set([".md", ".markdown", ".txt", ".jsonc", ".json"])
  const found: string[] = []
  const seen = new Set<string>()

  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || found.length > 4000) return
    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (
        e.name.startsWith(".git") ||
        e.name === "node_modules" ||
        e.name === "dist"
      )
        continue
      const full = join(dir, e.name)
      if (seen.has(full)) continue
      seen.add(full)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (wanted.has(extname(e.name))) {
        try {
          if (statSync(full).size <= 512 * 1024) found.push(full)
        } catch {
          // unreadable, skip
        }
      }
    }
  }
  for (const r of roots) walk(r, 0)
  return found
}

let fileCache: Array<{ path: string; text: string }> | null = null
function corpus(): Array<{ path: string; text: string }> {
  if (fileCache) return fileCache
  fileCache = []
  for (const p of candidates()) {
    try {
      fileCache.push({ path: p, text: readFileSync(p, "utf-8") })
    } catch {
      // unreadable, skip
    }
  }
  return fileCache
}

/**
 * Attribute a block to a file.
 *
 * Exact containment first — an instruction file is usually embedded verbatim.
 * Failing that, match on a distinctive interior line, which survives the
 * wrapping and interpolation OpenCode applies around the file's own text.
 */
function attribute(text: string): { path: string; how: string } | undefined {
  const files = corpus()
  const needle = text.trim()
  if (needle.length < 40) return undefined

  for (const f of files) {
    if (f.text.includes(needle))
      return { path: f.path, how: "block is inside the file" }
  }
  for (const f of files) {
    const t = f.text.trim()
    if (t.length > 80 && needle.includes(t))
      return { path: f.path, how: "file is inside the block" }
  }
  const lines = needle
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 45 && !/^[#>\-*|`\s]*$/.test(l))
  for (const probe of lines.slice(0, 40)) {
    const hits = files.filter((f) => f.text.includes(probe))
    if (hits.length === 1)
      return { path: hits[0]!.path, how: "unique line match" }
  }
  return undefined
}

const shapes = load()
if (shapes.length === 0) {
  console.log(`
No captured requests at ${capturePath()}

Turn capture on, send one message, then run this again:

  CLAUDE_AUTH_CAPTURE_REQUESTS=full opencode

  "full" records the system text so each block can be traced to its source file.
  "shape" records sizes only. Message content is never recorded at either level.
`)
  process.exit(0)
}

const chosen = all ? shapes : [shapes[shapes.length - 1]!]
const label = all ? `${shapes.length} captured requests` : "latest request"
const home = homedir()
const short = (p: string) =>
  p.startsWith(home)
    ? `~${relative(home, p) ? `/${relative(home, p)}` : ""}`
    : p

console.log(`\n  PROMPT COMPOSITION — ${label}\n`)

// --- system blocks ---------------------------------------------------------
const blocks = new Map<
  string,
  { bytes: number; head: string; count: number; cached: boolean; text?: string }
>()
for (const s of chosen) {
  for (const b of s.system) {
    const prev = blocks.get(b.sha1)
    if (prev) prev.count++
    else
      blocks.set(b.sha1, {
        bytes: b.bytes,
        head: b.head,
        count: 1,
        cached: b.cached,
        text: b.text,
      })
  }
}

const ranked = [...blocks.entries()].sort((a, b) => b[1].bytes - a[1].bytes)
const systemTotal = ranked.reduce((n, [, b]) => n + b.bytes, 0)
const hasText = ranked.some(([, b]) => b.text !== undefined)

console.log(
  `  SYSTEM PROMPT — ${kb(systemTotal)} (${tok(systemTotal)}) across ${ranked.length} block(s)\n`,
)
for (const [id, b] of ranked) {
  const src = b.text ? attribute(b.text) : undefined
  const pctOf = Math.round((b.bytes / Math.max(1, systemTotal)) * 100)
  console.log(
    `    ${kb(b.bytes).padStart(7)} ${String(pctOf).padStart(3)}% ${tok(b.bytes).padStart(9)}  ${b.cached ? "cached" : "  --  "}  ${id}`,
  )
  console.log(`      ${b.head}`)
  if (src) console.log(`      from: ${short(src.path)}   (${src.how})`)
  else if (hasText)
    console.log(
      `      from: unattributed — assembled by OpenCode, or no file matched`,
    )
  console.log()
}
if (!hasText) {
  console.log(
    '    (captured at level "shape": no text, so no source attribution)',
  )
  console.log(
    "    Re-run with CLAUDE_AUTH_CAPTURE_REQUESTS=full to trace blocks to files.\n",
  )
}

// --- tools -----------------------------------------------------------------
const tools = new Map<string, { bytes: number; desc: number }>()
for (const s of chosen) {
  for (const t of s.tools) {
    if (!tools.has(t.name))
      tools.set(t.name, { bytes: t.bytes, desc: t.descriptionBytes })
  }
}
const toolTotal = [...tools.values()].reduce((n, t) => n + t.bytes, 0)
console.log(
  `  TOOL SCHEMAS — ${kb(toolTotal)} (${tok(toolTotal)}) across ${tools.size} tool(s)\n`,
)
for (const [name, t] of [...tools.entries()]
  .sort((a, b) => b[1].bytes - a[1].bytes)
  .slice(0, 20)) {
  console.log(
    `    ${kb(t.bytes).padStart(7)} ${tok(t.bytes).padStart(9)}  ${name}   (description ${kb(t.desc)})`,
  )
}
if (tools.size > 20) console.log(`    ... and ${tools.size - 20} more`)

// --- totals ----------------------------------------------------------------
const last = chosen[chosen.length - 1]!
const fixed = last.systemBytes + last.toolBytes
console.log(`\n  PER REQUEST (most recent)\n`)
console.log(
  `    system       ${kb(last.systemBytes).padStart(8)} ${tok(last.systemBytes).padStart(10)}`,
)
console.log(
  `    tools        ${kb(last.toolBytes).padStart(8)} ${tok(last.toolBytes).padStart(10)}`,
)
console.log(
  `    messages     ${kb(last.messageBytes).padStart(8)} ${tok(last.messageBytes).padStart(10)}   (${last.messages.length} message(s))`,
)
console.log(`    ${"-".repeat(46)}`)
console.log(
  `    total        ${kb(last.bytes).padStart(8)} ${tok(last.bytes).padStart(10)}`,
)
console.log(
  `\n    fixed overhead (system + tools): ${kb(fixed)} — paid on every single request`,
)
console.log(
  `    of which cacheable: ${kb(last.cachedBytes)} (${Math.round((last.cachedBytes / Math.max(1, fixed)) * 100)}% of the overhead)`,
)
console.log(`\n  capture: ${capturePath()}\n`)
