/**
 * Where the plugin keeps its files: one folder, `~/.local/share/opencode/claude-auth/`.
 *
 * They used to sit loose in OpenCode's data folder as `claude-auth-*` and
 * `claude-account-source.txt`, among OpenCode's own files. The first lookup in
 * a process moves any of those into the folder (a rename, so nothing is
 * copied or lost), which lets a server and a TUI on different versions settle
 * on the new place as each restarts.
 */
import { existsSync, mkdirSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type DataFile =
  | "usage.jsonl"
  | "quota.json"
  | "samples.jsonl"
  | "identities.json"
  | "credit-denials.json"
  | "reserve-allows.json"
  | "requests.jsonl"
  | "debug.log"
  | "selection.txt"
  | "locks"
  | "tui-folds.json"
  | "report.txt"
  | "optimize.md"
  | "capture-mark.json"
  | "captures"

/** Old loose name -> name inside the folder. */
const LEGACY: Record<string, DataFile> = {
  "claude-auth-usage.jsonl": "usage.jsonl",
  "claude-auth-quota.json": "quota.json",
  "claude-auth-samples.jsonl": "samples.jsonl",
  "claude-auth-identities.json": "identities.json",
  "claude-auth-credit-denials.json": "credit-denials.json",
  "claude-auth-reserve-allows.json": "reserve-allows.json",
  "claude-auth-requests.jsonl": "requests.jsonl",
  "claude-auth-debug.log": "debug.log",
  "claude-account-source.txt": "selection.txt",
  "claude-auth-locks": "locks",
  "claude-auth-tui-folds.json": "tui-folds.json",
  "claude-auth-report.txt": "report.txt",
  "claude-auth-optimize.md": "optimize.md",
  "claude-auth-capture-mark.json": "capture-mark.json",
}
/** Rotated generations move with their file. */
const GENERATIONS = ["", ".1", ".2", ".3"]

const settled = new Set<string>()

export function legacyDir(home: string = homedir()): string {
  return join(home, ".local", "share", "opencode")
}

export function dataDir(home: string = homedir()): string {
  const dir = join(legacyDir(home), "claude-auth")
  if (!settled.has(dir)) {
    settled.add(dir)
    migrateLegacyData(home)
  }
  return dir
}

export function dataFile(name: DataFile, home: string = homedir()): string {
  return join(dataDir(home), name)
}

/**
 * Move loose files into the folder. A file already present in the folder
 * wins: it is the newer one, written by a process that had already moved.
 * Never throws; a file that cannot be moved is left where it was.
 */
export function migrateLegacyData(home: string = homedir()): string[] {
  const from = legacyDir(home)
  const to = join(from, "claude-auth")
  const moved: string[] = []
  try {
    if (!existsSync(from)) return moved
    const pending = Object.entries(LEGACY).flatMap(([old, name]) =>
      GENERATIONS.map((g) => [join(from, old + g), join(to, name + g)]),
    )
    if (!pending.some(([src]) => existsSync(src!))) return moved
    mkdirSync(to, { recursive: true, mode: 0o700 })
    for (const [src, dst] of pending) {
      try {
        if (!existsSync(src!) || existsSync(dst!)) continue
        renameSync(src!, dst!)
        moved.push(dst!)
      } catch {}
    }
  } catch {}
  return moved
}
