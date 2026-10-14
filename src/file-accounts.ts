// Multi-account discovery where there is no Keychain (Linux, Windows, containers).
//
// Claude Code keeps one OAuth blob per account in <CLAUDE_CONFIG_DIR>/.credentials.json.
// Upstream's non-macOS path read exactly one such directory, so a Linux host saw one
// account and the balancer had nothing to balance. This finds every directory, and
// names each account the way Claude Code names its Keychain entries on macOS
// (`Claude Code-credentials` for ~/.claude, `Claude Code-credentials-<sha256(dir)[:8]>`
// otherwise), so `accounts`, `accountNames` and presets in claude-auth.jsonc are written
// the same way on every platform.
//
// A host with a single default directory keeps upstream's source id `"file"`, so an
// existing single-account Linux setup reads and writes exactly as before.
import { createHash } from "node:crypto"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { ClaudeAccount, ClaudeCredentials } from "./keychain.ts"

export const FILE_SOURCE = "file"
const SERVICE = "Claude Code-credentials"

/** Keychain-style source id for a config directory (same hash Claude Code uses). */
export function sourceForConfigDir(dir: string, home: string): string {
  if (dir === join(home, ".claude")) return SERVICE
  return `${SERVICE}-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`
}

/**
 * Config directories holding credentials: $CLAUDE_CONFIG_DIR first, then every
 * `~/.claude*` directory with a `.credentials.json`, in name order.
 */
export function listCredentialDirs(
  home: string = homedir(),
  envDir: string | undefined = process.env.CLAUDE_CONFIG_DIR,
  has: (path: string) => boolean = existsSync,
  list: (dir: string) => string[] = (d) =>
    readdirSync(d, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name),
): string[] {
  const dirs: string[] = []
  const add = (dir: string) => {
    const bare = dir.endsWith("/") ? dir.slice(0, -1) : dir
    if (!dirs.includes(bare) && has(join(bare, ".credentials.json")))
      dirs.push(bare)
  }
  if (envDir) add(envDir)
  try {
    for (const name of list(home).sort()) {
      if (name === ".claude" || name.startsWith(".claude-"))
        add(join(home, name))
    }
  } catch {
    // An unreadable home only means nothing beyond $CLAUDE_CONFIG_DIR is found.
  }
  return dirs
}

/** Pairs each directory with its source id; a lone default directory stays "file". */
export function fileAccountSources(
  dirs: string[],
  home: string,
  envDir: string | undefined,
): Array<{ dir: string; source: string }> {
  const defaultDir = envDir ?? join(home, ".claude")
  if (dirs.length === 1 && dirs[0] === defaultDir)
    return [{ dir: dirs[0], source: FILE_SOURCE }]
  return dirs.map((dir) => ({ dir, source: sourceForConfigDir(dir, home) }))
}

/** All file-backed accounts. Readers are injected so this stays testable. */
export function readFileAccounts(
  readCreds: (dir: string) => ClaudeCredentials | null,
  readEmail: (dir: string) => string | null,
  label: (
    creds: ClaudeCredentials[],
    emails: (string | null)[],
    sources: (string | null)[],
  ) => string[],
  home: string = homedir(),
  envDir: string | undefined = process.env.CLAUDE_CONFIG_DIR,
  dirs: string[] = listCredentialDirs(home, envDir),
): ClaudeAccount[] {
  const found = fileAccountSources(dirs, home, envDir)
    .map(({ dir, source }) => ({ dir, source, creds: readCreds(dir) }))
    .filter(
      (f): f is { dir: string; source: string; creds: ClaudeCredentials } =>
        f.creds !== null,
    )
  const labels = label(
    found.map((f) => f.creds),
    found.map((f) => readEmail(f.dir)),
    found.map((f) => (f.source === FILE_SOURCE ? null : f.source)),
  )
  return found.map((f, i) => ({
    label: labels[i],
    source: f.source,
    configDir: f.dir,
    credentials: f.creds,
  }))
}

/** True when a source is backed by a .credentials.json file rather than the Keychain. */
export function isFileSource(source: string, configDir?: string): boolean {
  return (
    source === FILE_SOURCE || (process.platform !== "darwin" && !!configDir)
  )
}
