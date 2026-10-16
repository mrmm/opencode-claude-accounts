/**
 * What this OpenCode setup loads into every request, read from disk.
 *
 * The hints need names, not just sizes: "AGENTS.md loaded twice" and "9 agents
 * listed twice" are only actionable when they say which files. Everything here is
 * deterministic, so it is code and not a model call.
 */

import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

export type InstructionFile = {
  path: string
  bytes: number
  hash: string
  kind: "agents" | "rule"
}

export type SetupScan = {
  files: InstructionFile[]
  /** Agent names that appear both globally and in the project (overlord-x == x). */
  duplicateAgents: string[]
  agentCount: number
}

const read = (
  path: string,
  home: string,
  kind: InstructionFile["kind"],
): InstructionFile | undefined => {
  try {
    const text = readFileSync(path)
    return {
      path: path.startsWith(home) ? "~" + path.slice(home.length) : path,
      bytes: text.length,
      hash: createHash("sha1").update(text).digest("hex"),
      kind,
    }
  } catch {
    return undefined // unreadable: OpenCode could not load it either
  }
}

/**
 * The `instructions` array of an opencode.json(c). Read with a regex rather than a
 * JSONC parser: only the quoted strings of that one array are needed.
 */
export function instructionPaths(configText: string): string[] {
  const live = configText.replace(/^\s*\/\/.*$/gm, "")
  const block = /"instructions"\s*:\s*\[([\s\S]*?)\]/.exec(live)?.[1] ?? ""
  return [...block.matchAll(/^\s*"([^"]+)"/gm)].map((m) => m[1]!)
}

const agentNames = (dir: string): string[] => {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
  } catch {
    return []
  }
}

/** Nearest `.opencode` directory from `directory` up to (not including) home. */
function projectConfigDir(directory: string, home: string): string | undefined {
  for (let d = directory; d && d !== dirname(d) && d !== home; d = dirname(d))
    if (existsSync(join(d, ".opencode"))) return join(d, ".opencode")
  return undefined
}

export function scanSetup(
  directory: string,
  home: string,
  configHome = join(home, ".config"),
): SetupScan {
  const globalDir = join(configHome, "opencode")
  const expand = (p: string, base: string) =>
    p.startsWith("~/")
      ? join(home, p.slice(2))
      : p.startsWith("/")
        ? p
        : join(base, p)

  // AGENTS.md: the global one, then the nearest AGENTS.md (else CLAUDE.md) per level.
  // shortcut: mirrors OpenCode's lookup by hand; read the resolved list from the server
  // if it ever drifts from this.
  const agentsMd: string[] = []
  if (existsSync(join(globalDir, "AGENTS.md")))
    agentsMd.push(join(globalDir, "AGENTS.md"))
  for (let d = directory; d && d !== dirname(d) && d !== home; d = dirname(d)) {
    const f = ["AGENTS.md", "CLAUDE.md"]
      .map((n) => join(d, n))
      .find((p) => existsSync(p))
    if (f) agentsMd.push(f)
  }

  const project = projectConfigDir(directory, home)
  const rules: string[] = []
  for (const [cfgDir, base] of [
    [globalDir, globalDir],
    ...(project ? [[project, dirname(project)]] : []),
  ] as [string, string][]) {
    for (const name of ["opencode.jsonc", "opencode.json"]) {
      try {
        for (const p of instructionPaths(
          readFileSync(join(cfgDir, name), "utf-8"),
        ))
          rules.push(expand(p, base))
      } catch {
        /* no such config */
      }
    }
  }

  const files: InstructionFile[] = []
  const seen = new Set<string>()
  const push = (p: string, kind: InstructionFile["kind"]) => {
    // The same path listed twice is loaded once; the same CONTENT at two paths is not,
    // and that is what duplicateInstructions reports.
    if (seen.has(p)) return
    seen.add(p)
    const f = read(p, home, kind)
    if (f) files.push(f)
  }
  for (const p of agentsMd) push(p, "agents")
  for (const p of rules) push(p, "rule")

  const globalAgents = [
    ...agentNames(join(globalDir, "agent")),
    ...agentNames(join(globalDir, "agents")),
  ]
  const projectAgents = project
    ? [
        ...agentNames(join(project, "agent")),
        ...agentNames(join(project, "agents")),
      ]
    : []
  const local = new Set(projectAgents)
  const duplicateAgents = globalAgents.filter(
    (g) => local.has(g) || local.has(g.replace(/^overlord-/, "")),
  )

  return {
    files,
    duplicateAgents,
    agentCount: new Set([...globalAgents, ...projectAgents]).size,
  }
}
