import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"

import {
  fileAccountSources,
  listCredentialDirs,
  readFileAccounts,
  sourceForConfigDir,
} from "./file-accounts.ts"
import type { ClaudeCredentials } from "./keychain.ts"

const HOME = "/home/u"
const creds = (token: string): ClaudeCredentials =>
  ({
    accessToken: token,
    refreshToken: `r-${token}`,
    expiresAt: 1,
  }) as ClaudeCredentials
const fsWith = (files: string[]) => (p: string) => files.includes(p)
const listing = () => [
  ".claude-team-2",
  ".bashrc",
  ".claude",
  ".claude-team-1",
  ".claudex",
  ".config",
]

describe("sourceForConfigDir", () => {
  it("names ~/.claude like Claude Code's unsuffixed Keychain entry", () => {
    assert.equal(
      sourceForConfigDir("/home/u/.claude", HOME),
      "Claude Code-credentials",
    )
  })
  it("suffixes other directories with sha256(dir)[:8], as Claude Code does", () => {
    const want = createHash("sha256")
      .update("/home/u/.claude-team-1")
      .digest("hex")
      .slice(0, 8)
    assert.equal(
      sourceForConfigDir("/home/u/.claude-team-1", HOME),
      `Claude Code-credentials-${want}`,
    )
  })
})

describe("listCredentialDirs", () => {
  it("finds every ~/.claude and ~/.claude-* directory holding credentials, sorted", () => {
    const has = fsWith([
      "/home/u/.claude/.credentials.json",
      "/home/u/.claude-team-1/.credentials.json",
      "/home/u/.claude-team-2/.credentials.json",
      "/home/u/.claudex/.credentials.json",
    ])
    assert.deepEqual(listCredentialDirs(HOME, undefined, has, listing), [
      "/home/u/.claude",
      "/home/u/.claude-team-1",
      "/home/u/.claude-team-2",
    ])
  })
  it("skips directories without a credentials file", () => {
    const has = fsWith(["/home/u/.claude-team-2/.credentials.json"])
    assert.deepEqual(listCredentialDirs(HOME, undefined, has, listing), [
      "/home/u/.claude-team-2",
    ])
  })
  it("puts $CLAUDE_CONFIG_DIR first and does not list it twice (trailing slash)", () => {
    const has = fsWith([
      "/home/u/.claude-team-2/.credentials.json",
      "/home/u/.claude/.credentials.json",
    ])
    assert.deepEqual(
      listCredentialDirs(HOME, "/home/u/.claude-team-2/", has, listing),
      ["/home/u/.claude-team-2", "/home/u/.claude"],
    )
  })
  it("survives an unreadable home", () => {
    const has = fsWith(["/x/.credentials.json"])
    const boom = () => {
      throw new Error("EACCES")
    }
    assert.deepEqual(listCredentialDirs(HOME, "/x", has, boom), ["/x"])
  })
})

describe("fileAccountSources", () => {
  it("keeps upstream's 'file' id for a lone default directory", () => {
    assert.deepEqual(fileAccountSources(["/home/u/.claude"], HOME, undefined), [
      { dir: "/home/u/.claude", source: "file" },
    ])
  })
  it("gives each of several directories its own Keychain-style id", () => {
    const got = fileAccountSources(
      ["/home/u/.claude", "/home/u/.claude-team-1"],
      HOME,
      undefined,
    )
    assert.equal(got[0].source, "Claude Code-credentials")
    assert.match(got[1].source, /^Claude Code-credentials-[0-9a-f]{8}$/)
  })
  it("a lone non-default directory is not 'file' (ids must not collide with upstream's default)", () => {
    const [only] = fileAccountSources(
      ["/home/u/.claude-team-1"],
      HOME,
      undefined,
    )
    assert.match(only.source, /^Claude Code-credentials-/)
  })
})

describe("readFileAccounts", () => {
  const label = (
    cs: ClaudeCredentials[],
    emails: (string | null)[],
    sources: (string | null)[],
  ) => cs.map((_, i) => `${emails[i]}|${sources[i] ?? "-"}`)

  it("returns one account per readable directory, with its own source and config dir", () => {
    const accounts = readFileAccounts(
      (dir) => (dir.endsWith("-3") ? null : creds(dir)),
      () => "me@example.com",
      label,
      HOME,
      undefined,
      [
        "/home/u/.claude-team-1",
        "/home/u/.claude-team-2",
        "/home/u/.claude-team-3",
      ],
    )
    assert.equal(
      accounts.length,
      2,
      "an unreadable directory is skipped, not an empty account",
    )
    assert.deepEqual(
      accounts.map((a) => a.configDir),
      ["/home/u/.claude-team-1", "/home/u/.claude-team-2"],
    )
    assert.notEqual(accounts[0].source, accounts[1].source)
    assert.equal(accounts[0].credentials.accessToken, "/home/u/.claude-team-1")
    assert.match(
      accounts[0].label,
      /^me@example\.com\|Claude Code-credentials-[0-9a-f]{8}$/,
    )
  })
  it("a single default account keeps source 'file' and is labelled without a source id", () => {
    const [only] = readFileAccounts(
      () => creds("t"),
      () => null,
      label,
      HOME,
      undefined,
      ["/home/u/.claude"],
    )
    assert.equal(only.source, "file")
    assert.equal(only.label, "null|-")
  })
  it("returns nothing when no directory has credentials", () => {
    assert.deepEqual(
      readFileAccounts(
        () => creds("t"),
        () => null,
        label,
        HOME,
        undefined,
        [],
      ),
      [],
    )
  })
})
