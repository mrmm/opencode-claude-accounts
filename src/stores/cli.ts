// Operator commands for declared credential stores.
//
//   node dist/stores/cli.js check            every declared store: present? expires in?
//   node dist/stores/cli.js login <id>       run `claude` in a throwaway RAM config dir,
//                                            then move the resulting login into store <id>
//   node dist/stores/cli.js import <id> [--from <dir>|-]
//                                            move an existing login (dir or stdin) into <id>
//
// `login` exists because a headless host must not keep Claude Code's
// .credentials.json: the login happens in a directory on tmpfs, the blob goes
// straight into the store (a secret broker, for a helper store), and the
// directory is deleted. No token is ever printed.
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { getConfig, primeConfig, type StoreSpec } from "../config.ts"
import { parseCredentials } from "../keychain.ts"
import { buildStore } from "./build.ts"
import { runHelper, type Exec } from "./helper.ts"

export type CliIO = {
  out: (line: string) => void
  err: (line: string) => void
  stdin: () => string
  exec?: Exec
  /** Runs `claude` interactively with the given config dir; returns exit status. */
  runClaude: (configDir: string) => number
  ramDir: () => string
  now: () => number
}

function specFor(
  stores: StoreSpec[],
  id: string | undefined,
): StoreSpec | undefined {
  return stores.find((s) => s.id === id)
}

/** Store a raw Claude Code credential blob as-is (keeps scopes and metadata). */
export function importBlob(spec: StoreSpec, raw: string, exec?: Exec): boolean {
  if (!parseCredentials(raw)) return false
  if (spec.backend === "helper") {
    return runHelper(spec.command ?? [], "store", spec.id, raw, exec) !== null
  }
  if (spec.backend === "file" && spec.configDir) {
    writeFileSync(join(spec.configDir, ".credentials.json"), raw, {
      mode: 0o600,
    })
    return true
  }
  return false // Keychain logins are written by Claude Code itself on macOS.
}

export function describeExpiry(expiresAt: number, now: number): string {
  const mins = Math.round((expiresAt - now) / 60_000)
  if (mins <= 0) return "expired (refreshable if a refresh token is held)"
  return mins < 120
    ? `expires in ${mins}m`
    : `expires in ${Math.round(mins / 60)}h`
}

export function runCli(argv: string[], stores: StoreSpec[], io: CliIO): number {
  const [cmd, id, ...rest] = argv

  if (cmd === "check") {
    if (stores.length === 0) {
      io.err("no stores declared in claude-auth.jsonc (`stores`)")
      return 1
    }
    let missing = 0
    for (const spec of stores) {
      const creds = buildStore(spec, io.exec).read()
      if (!creds) missing++
      io.out(
        `${spec.id}\t${spec.backend}\t${creds ? describeExpiry(creds.expiresAt, io.now()) : "MISSING"}`,
      )
    }
    return missing === 0 ? 0 : 2
  }

  if (cmd === "import" || cmd === "login") {
    const spec = specFor(stores, id)
    if (!spec) {
      io.err(
        `unknown store "${id ?? ""}" — declared: ${stores.map((s) => s.id).join(", ") || "none"}`,
      )
      return 1
    }

    let raw: string
    if (cmd === "import") {
      const from = rest[0] === "--from" ? rest[1] : undefined
      raw =
        !from || from === "-"
          ? io.stdin()
          : readFileSync(join(from, ".credentials.json"), "utf-8")
    } else {
      const dir = mkdtempSync(join(io.ramDir(), "claude-login-"))
      try {
        io.err(
          `Complete the Claude login in the session that opens, then type /exit.`,
        )
        const status = io.runClaude(dir)
        const path = join(dir, ".credentials.json")
        if (status !== 0 && !existsSync(path)) {
          io.err(`claude exited with ${status} and no login was saved`)
          return 1
        }
        raw = existsSync(path) ? readFileSync(path, "utf-8") : ""
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    if (!importBlob(spec, raw, io.exec)) {
      io.err(`no valid Claude credentials to store in "${spec.id}"`)
      return 1
    }
    const creds = parseCredentials(raw)
    io.out(
      `${spec.id}: stored (${creds ? describeExpiry(creds.expiresAt, io.now()) : "?"})`,
    )
    return 0
  }

  io.err("usage: cli.js check | login <id> | import <id> [--from <dir>|-]")
  return 1
}

/** Prefer RAM-backed directories so a login never lands on a persistent disk. */
export function pickRamDir(has: (p: string) => boolean = existsSync): string {
  const run = process.env.XDG_RUNTIME_DIR
  if (run && has(run)) return run
  if (has("/dev/shm")) return "/dev/shm"
  return tmpdir()
}

const isMain =
  process.argv[1]?.endsWith("/stores/cli.js") ||
  process.argv[1]?.endsWith("/stores/cli.ts")
if (isMain) {
  primeConfig(process.cwd())
  const code = runCli(process.argv.slice(2), getConfig().stores, {
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    stdin: () => readFileSync(0, "utf-8"),
    runClaude: (dir) =>
      spawnSync("claude", [], {
        stdio: "inherit",
        env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
      }).status ?? 1,
    ramDir: () => pickRamDir(),
    now: () => Date.now(),
  })
  process.exit(code)
}
