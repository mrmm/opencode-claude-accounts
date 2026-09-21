/**
 * The running build's version.
 *
 * Read from package.json rather than restated, because a hand-copied constant
 * drifts and a version that lies is worse than no version at all. Both
 * `src/version.ts` and the compiled `dist/version.js` sit one level below the
 * package root, so the same relative path resolves from either.
 *
 * A missing or unreadable package.json yields "unknown": a version string is
 * never worth failing a plugin load over.
 */
import { readFileSync } from "node:fs"

function read(): string {
  try {
    const raw = readFileSync(
      new URL("../package.json", import.meta.url),
      "utf8",
    )
    const v = (JSON.parse(raw) as { version?: unknown }).version
    return typeof v === "string" && v.length > 0 ? v : "unknown"
  } catch {
    return "unknown"
  }
}

export const VERSION = read()
