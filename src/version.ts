/**
 * What is actually running: the declared version, and the commit that built it.
 *
 * Both are read rather than restated -- a hand-copied constant drifts, and a
 * version that lies is worse than no version at all.
 *
 * The commit comes from `dist/build-info.json`, written by `scripts/stamp.mjs`
 * during the build. Reading `.git` here instead would report the working
 * tree's HEAD, which is a different thing from the code that is running the
 * moment dist/ is stale -- and telling those two apart is the entire point.
 *
 * Both paths resolve the same URLs: `src/version.ts` and `dist/version.js` sit
 * one level below the package root. Anything unreadable degrades to "unknown";
 * a version string is never worth failing a plugin load over.
 */
import { readFileSync } from "node:fs"

function json(relative: string): Record<string, unknown> | null {
  try {
    return JSON.parse(
      readFileSync(new URL(relative, import.meta.url), "utf8"),
    ) as Record<string, unknown>
  } catch {
    return null
  }
}

function readVersion(): string {
  const v = json("../package.json")?.version
  return typeof v === "string" && v.length > 0 ? v : "unknown"
}

function readCommit(): string | null {
  const info = json("../dist/build-info.json")
  if (!info) return null
  const c = info.commit
  if (typeof c !== "string" || c.length === 0) return null
  // A build made over uncommitted edits is not that commit, and saying so is
  // the difference between a useful stamp and a misleading one.
  return info.dirty === true ? `${c}-dirty` : c
}

export const VERSION = readVersion()
export const COMMIT = readCommit()

/** `2.1.4+c43a5b5`, or just the version when no build stamp is present. */
export const BUILD = COMMIT ? `${VERSION}+${COMMIT}` : VERSION
