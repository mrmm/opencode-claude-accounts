import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mkdtempSync, renameSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { primeJsonFresh, readJsonFresh } from "./file-memo.ts"

const fresh = () => join(mkdtempSync(join(tmpdir(), "file-memo-")), "f.json")

describe("readJsonFresh", () => {
  it("parses once while the file is unchanged", () => {
    const p = fresh()
    writeFileSync(p, '{"a":1}')
    let parses = 0
    const parse = (raw: unknown) => {
      parses++
      return raw as Record<string, number>
    }
    const first = readJsonFresh(p, parse, {})
    assert.equal(readJsonFresh(p, parse, {}), first)
    assert.equal(parses, 1)
  })

  it("re-reads after a tmp + rename write, as another process does it", () => {
    const p = fresh()
    writeFileSync(p, '{"a":1}')
    assert.deepEqual(
      readJsonFresh(p, (r) => r, {}),
      { a: 1 },
    )
    writeFileSync(`${p}.tmp`, '{"a":2}')
    renameSync(`${p}.tmp`, p)
    assert.deepEqual(
      readJsonFresh(p, (r) => r, {}),
      { a: 2 },
    )
  })

  it("re-reads after an in-place write of the same size", () => {
    const p = fresh()
    writeFileSync(p, '{"a":1}')
    readJsonFresh(p, (r) => r, {})
    writeFileSync(p, '{"a":3}')
    assert.deepEqual(
      readJsonFresh(p, (r) => r, {}),
      { a: 3 },
    )
  })

  it("falls back on a missing file or bad JSON, and forgets the old value", () => {
    const p = fresh()
    assert.deepEqual(
      readJsonFresh(p, (r) => r, { none: true }),
      { none: true },
    )
    writeFileSync(p, '{"a":1}')
    readJsonFresh(p, (r) => r, {})
    writeFileSync(p, "{oops")
    assert.deepEqual(
      readJsonFresh(p, (r) => r, {}),
      {},
    )
  })

  it("primeJsonFresh makes the writer's value the next read", () => {
    const p = fresh()
    writeFileSync(p, '{"a":1}')
    const v = { a: 1, primed: true }
    primeJsonFresh(p, v)
    assert.equal(
      readJsonFresh(p, () => assert.fail("should not parse"), {}),
      v,
    )
  })
})
