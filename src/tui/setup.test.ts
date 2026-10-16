import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { instructionPaths, scanSetup } from "./setup.ts"
import { hints } from "./traffic.ts"

describe("instructionPaths", () => {
  it("reads the instructions array and skips comments", () => {
    const cfg = `{
  // "instructions": ["no"],
  "instructions": [
    "~/a.md",
    // commented
    "rules/b.md"
  ],
  "other": ["x"]
}`
    assert.deepEqual(instructionPaths(cfg), ["~/a.md", "rules/b.md"])
  })
})

describe("scanSetup", () => {
  it("finds a global AGENTS.md linked to the repo's, rule files, and duplicate agents", () => {
    const home = mkdtempSync(join(tmpdir(), "setup-"))
    const repo = join(home, "code", "repo")
    const global = join(home, ".config", "opencode")
    mkdirSync(join(repo, ".opencode", "agent"), { recursive: true })
    mkdirSync(join(global, "agent"), { recursive: true })
    mkdirSync(join(global, "rules"), { recursive: true })
    writeFileSync(join(repo, "AGENTS.md"), "x".repeat(3700))
    symlinkSync(join(repo, "AGENTS.md"), join(global, "AGENTS.md"))
    writeFileSync(join(global, "rules", "big.md"), "y".repeat(370))
    writeFileSync(
      join(global, "opencode.jsonc"),
      `{ "instructions": ["~/.config/opencode/rules/big.md"] }`,
    )
    for (const a of ["builder", "reviewer"])
      writeFileSync(join(repo, ".opencode", "agent", `${a}.md`), a)
    for (const a of ["overlord-builder", "overlord-reviewer", "overlord-only"])
      writeFileSync(join(global, "agent", `${a}.md`), a)

    const scan = scanSetup(repo, home)
    assert.deepEqual(
      scan.files.map((f) => [f.path, f.kind]),
      [
        ["~/.config/opencode/AGENTS.md", "agents"],
        ["~/code/repo/AGENTS.md", "agents"],
        ["~/.config/opencode/rules/big.md", "rule"],
      ],
    )
    assert.deepEqual(scan.duplicateAgents, [
      "overlord-builder",
      "overlord-reviewer",
    ])

    // The hints now name what the scan found.
    const rows = hints({
      files: scan.files,
      duplicateAgents: scan.duplicateAgents,
      composition: {
        system: 0,
        tools: 3_000,
        messages: 40_000,
        instructions: 35_000,
        injected: 0,
        conversation: 5_000,
        fixed: 38_000,
        blocks: [],
        toolGroups: [{ group: "Subagent", tokens: 3_000, count: 1 }],
      },
    })
    const by = Object.fromEntries(rows.map((r) => [r.label, r.value]))
    assert.equal(by.duplicate, "AGENTS.md ×2: ~1.0k/turn, keep one")
    assert.equal(
      by.instructions,
      "~35.0k/turn, biggest: AGENTS.md 1.0k, big.md 100",
    )
    assert.equal(
      by.schema,
      "Subagent ~3.0k: 2 agents listed twice (overlord-builder…)",
    )
  })

  it("drops the duplicate and agent hints once they are fixed", () => {
    const rows = hints({
      files: [{ path: "~/repo/AGENTS.md", bytes: 3700, hash: "a" }],
      duplicateAgents: [],
      composition: {
        system: 0,
        tools: 3_000,
        messages: 0,
        instructions: 0,
        injected: 0,
        conversation: 0,
        fixed: 3_000,
        blocks: [],
        toolGroups: [{ group: "Subagent", tokens: 3_000, count: 1 }],
      },
    })
    assert.deepEqual(
      rows.map((r) => r.label),
      ["schema"],
    )
    assert.match(rows[0]!.value, /long description/)
  })
})
