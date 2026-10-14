// Credential-helper protocol: tokens kept by an external program, never on disk.
//
// Same shape as git's and docker's credential helpers, so any secret broker can
// implement it in a few lines:
//
//   <command...> get <id>     stdout: the account's credential JSON, exit 0
//                             (Claude Code's own shape: {"claudeAiOauth": {...}})
//                             non-zero exit or empty output = no credentials
//   <command...> store <id>   stdin: the full credential JSON; exit 0 = stored
//   <command...> list         stdout: one id per line (optional; used by `check`)
//
// stdout is a secret and is never logged; only the exit status and timing are.
import { execFileSync } from "node:child_process"

export type HelperOp = "get" | "store" | "list"

export type Exec = (
  file: string,
  args: string[],
  opts: {
    input?: string
    timeout: number
    encoding: "utf-8"
    stdio: Array<"pipe" | "ignore">
  },
) => string

const defaultExec: Exec = (file, args, opts) =>
  execFileSync(file, args, { ...opts, maxBuffer: 1024 * 1024 })

export const HELPER_TIMEOUT_MS = 10_000

/** Run one helper operation; returns stdout, or null on any failure. */
export function runHelper(
  command: string[],
  op: HelperOp,
  id?: string,
  input?: string,
  exec: Exec = defaultExec,
): string | null {
  const [file, ...base] = command
  if (!file) return null
  const args = id === undefined ? [...base, op] : [...base, op, id]
  try {
    const out = exec(file, args, {
      input,
      timeout: HELPER_TIMEOUT_MS,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    })
    return typeof out === "string" ? out : String(out)
  } catch {
    // Non-zero exit is the protocol's "absent / refused"; a timeout or missing
    // binary reads the same way. Both mean: this store has nothing for us now.
    return null
  }
}
