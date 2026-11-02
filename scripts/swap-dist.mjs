// Replace dist/ with .dist-next/ in two renames.
//
// The plugin is loaded from dist/ by running OpenCode processes. `rm -rf dist`
// followed by a move left a window where a lazy import found no dist/ at all,
// or a half-deleted one, and failed with a missing export. Two renames shrink
// that window to microseconds; the old tree is deleted after, off the hot path.
import { existsSync, renameSync, rmSync } from "node:fs"

const old = `.dist-old-${process.pid}`
if (existsSync("dist")) renameSync("dist", old)
renameSync(".dist-next", "dist")
rmSync(old, { recursive: true, force: true })
