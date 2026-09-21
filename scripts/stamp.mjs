/**
 * Record which commit produced dist/.
 *
 * Written at build time on purpose. Reading .git at runtime would report the
 * working tree's HEAD, which is a different thing from the code that is
 * running the moment dist/ is stale -- and telling those two apart is the only
 * reason the stamp exists.
 */
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"

const git = (...args) => {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return ""
  }
}

const commit = git("rev-parse", "--short", "HEAD")
const dirty = commit ? git("status", "--porcelain").length > 0 : false

writeFileSync(
  new URL("../dist/build-info.json", import.meta.url),
  JSON.stringify(
    { commit: commit || null, dirty, builtAt: new Date().toISOString() },
    null,
    2,
  ),
)
console.log(`stamped ${commit || "unknown"}${dirty ? "-dirty" : ""}`)
