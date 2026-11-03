/**
 * Which sidebar sections are folded.
 *
 * The sidebar is shared by every session and survives restarts in the user's
 * head, so the choice is kept in a small file rather than in memory: a section
 * folded once stays folded. Unknown or unreadable state means everything open.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"

import { dirname } from "node:path"
import { dataFile } from "../paths.ts"

export type FoldState = Record<string, boolean>

export function foldStatePath(): string {
  return dataFile("tui-folds.json")
}

export function toggleFold(state: FoldState, key: string): FoldState {
  const next = { ...state }
  if (next[key]) delete next[key]
  else next[key] = true
  return next
}

export function readFolds(path: string = foldStatePath()): FoldState {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
    const out: FoldState = {}
    for (const [k, v] of Object.entries(raw)) if (v === true) out[k] = true
    return out
  } catch {
    return {}
  }
}

export function writeFolds(
  state: FoldState,
  path: string = foldStatePath(),
): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(state))
  } catch {
    // A fold that does not persist is cosmetic; never fail a render over it.
  }
}
