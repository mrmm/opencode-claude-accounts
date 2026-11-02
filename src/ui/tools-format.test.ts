import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  cacheAccountLines,
  cacheLine,
  cacheSessionLines,
  classifySelection,
  parseWindowMs,
  reserveRefusal,
} from "./tools-format.ts"

describe("classifySelection", () => {
  it("reads the three things the selection file can hold", () => {
    assert.deepEqual(classifySelection(null, []), { kind: "none" })
    assert.deepEqual(classifySelection("__auto__", []), { kind: "auto" })
    assert.deepEqual(classifySelection("Claude Code-credentials-abc", []), {
      kind: "pin",
      source: "Claude Code-credentials-abc",
    })
  })

  it("flags a preset that is selected but not defined", () => {
    // A typo must be reported, not silently treated as a pin.
    assert.deepEqual(classifySelection("preset:typo", ["rr-12"]), {
      kind: "preset",
      name: "typo",
      known: false,
    })
    assert.deepEqual(classifySelection("preset:rr-12", ["rr-12"]), {
      kind: "preset",
      name: "rr-12",
      known: true,
    })
  })

  it("treats an empty string as nothing selected", () => {
    assert.deepEqual(classifySelection("", ["rr-12"]), { kind: "none" })
  })
})

describe("parseWindowMs", () => {
  it("parses each unit", () => {
    assert.equal(parseWindowMs("30s"), 30_000)
    assert.equal(parseWindowMs("15m"), 900_000)
    assert.equal(parseWindowMs("2h"), 7_200_000)
    assert.equal(parseWindowMs("7d"), 604_800_000)
  })

  it("falls back rather than throwing on nonsense", () => {
    // A model may pass anything; a bad window should still produce a report.
    assert.equal(parseWindowMs("yesterday"), parseWindowMs("24h"))
    assert.equal(parseWindowMs(undefined), parseWindowMs("24h"))
    assert.equal(parseWindowMs(""), parseWindowMs("24h"))
  })
})

describe("reserveRefusal", () => {
  it("refuses the agent turning reserve on unless the operator allowed it", () => {
    assert.match(reserveRefusal("on", false) ?? "", /^Refused/)
    assert.equal(reserveRefusal("on", true), undefined)
    assert.equal(reserveRefusal("off", false), undefined)
  })
})

describe("cache lines", () => {
  const s = (over: Record<string, unknown>) => ({
    requests: 10,
    hitRate: 0.9,
    saved: 0.8,
    misses: 0,
    byCause: {},
    ...over,
  })
  const b = {
    global: s({}),
    accounts: [
      s({ account: "acme-3", requests: 50 }),
      s({ account: "acme-1", requests: 5 }),
      s({ account: "stray", requests: 1 }),
    ],
    sessions: [
      s({
        session: "ses_aaaaaaaa11111111",
        misses: 3,
        byCause: {
          "ttl-expired": { n: 2, tokens: 900 },
          "model-change": { n: 1, tokens: 100 },
        },
      }),
      s({ session: "ses_bbbb", misses: 0 }),
    ],
  } as unknown as Parameters<typeof cacheAccountLines>[0]

  it("orders accounts as configured, unconfigured last", () => {
    const lines = cacheAccountLines(b, ["acme-1", "acme-3"], (id) =>
      id === "acme-1" ? "Team 1" : id,
    )
    assert.deepEqual(
      lines.map((l) => l.trim().split(/\s+/)[0]),
      ["acme-1", "acme-3", "stray"],
    )
    assert.ok(lines[0]!.includes("Team 1"))
  })

  it("lists only sessions that missed, naming the costliest cause", () => {
    const lines = cacheSessionLines(b)
    assert.equal(lines.length, 1)
    assert.ok(lines[0]!.includes("11111111"))
    assert.ok(lines[0]!.endsWith("3 misses, mostly TTL expired"))
  })

  it("says so when nothing missed", () => {
    assert.equal(
      cacheLine(b.global),
      "90% reused · input cost 80% lower · 10 req · no misses",
    )
  })
})
