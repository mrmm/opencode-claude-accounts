import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readFolds, toggleFold, writeFolds } from "./fold.ts"

describe("fold state", () => {
  it("toggles a section on and off", () => {
    const once = toggleFold({}, "forecast")
    assert.deepEqual(once, { forecast: true })
    assert.deepEqual(toggleFold(once, "forecast"), {})
  })

  it("round-trips through the file and ignores junk", () => {
    const path = join(mkdtempSync(join(tmpdir(), "fold-")), "f.json")
    assert.deepEqual(readFolds(path), {}, "missing file means all open")
    writeFolds({ accounts: true }, path)
    assert.deepEqual(readFolds(path), { accounts: true })
    writeFileSync(path, '{"a":true,"b":"yes","c":false}')
    assert.deepEqual(readFolds(path), { a: true })
    writeFileSync(path, "not json")
    assert.deepEqual(readFolds(path), {})
  })
})
