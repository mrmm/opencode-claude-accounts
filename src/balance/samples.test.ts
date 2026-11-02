import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  BUCKET_MS,
  RETENTION_MS,
  SampleAggregator,
  appendSample,
  bucketStart,
  prune,
  readSamples,
  type Sample,
} from "./samples.ts"

const T0 = 1785000000000 // some fixed bucket boundary neighbourhood

describe("bucketStart", () => {
  it("floors to the 5-minute boundary", () => {
    const base = bucketStart(T0)
    assert.equal(bucketStart(base + 1), base)
    assert.equal(bucketStart(base + BUCKET_MS - 1), base)
    assert.equal(bucketStart(base + BUCKET_MS), base + BUCKET_MS)
  })
})

describe("SampleAggregator", () => {
  it("accumulates one row per account per bucket and flushes on rollover", () => {
    const flushed: Sample[] = []
    const agg = new SampleAggregator((s) => flushed.push(s))
    const base = bucketStart(T0)

    agg.observe({
      at: base + 1,
      account: "a",
      input: 100,
      cacheRead: 10,
      u5: 0.2,
    })
    agg.observe({ at: base + 2, account: "a", input: 50, output: 20, u5: 0.3 })
    // same bucket for a different account stays separate
    agg.observe({ at: base + 3, account: "b", input: 5 })
    assert.equal(flushed.length, 0, "nothing flushed while bucket is open")

    // next bucket for account a closes its previous bucket
    agg.observe({ at: base + BUCKET_MS + 1, account: "a", input: 1 })
    assert.equal(flushed.length, 1)
    const row = flushed[0]!
    assert.equal(row.account, "a")
    assert.equal(row.at, base)
    assert.equal(row.reqs, 2)
    assert.equal(row.input, 150)
    assert.equal(row.output, 20)
    assert.equal(row.cacheRead, 10)
    assert.equal(row.u5, 0.3) // newest gauge wins
  })

  it("flush emits every open bucket and clears", () => {
    const flushed: Sample[] = []
    const agg = new SampleAggregator((s) => flushed.push(s))
    const base = bucketStart(T0)
    agg.observe({ at: base, account: "a", input: 1 })
    agg.observe({ at: base, account: "b", input: 2 })
    agg.flush()
    assert.equal(flushed.length, 2)
    agg.flush()
    assert.equal(flushed.length, 2, "nothing left after a flush")
  })
})

describe("prune", () => {
  it("keeps only rows within the retention window", () => {
    const now = T0
    const rows: Sample[] = [
      {
        at: now,
        account: "a",
        reqs: 1,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      {
        at: now - RETENTION_MS + 1,
        account: "a",
        reqs: 1,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      {
        at: now - RETENTION_MS - 1,
        account: "a",
        reqs: 1,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    ]
    const kept = prune(rows, now)
    assert.equal(kept.length, 2)
    assert.ok(kept.every((r) => r.at >= now - RETENTION_MS))
  })
})

describe("appendSample + readSamples", () => {
  const tmpFile = () => join(mkdtempSync(join(tmpdir(), "samples-")), "s.jsonl")

  it("round-trips a sample", () => {
    const path = tmpFile()
    const s: Sample = {
      at: T0,
      account: "a",
      reqs: 3,
      input: 10,
      output: 20,
      cacheRead: 5,
      cacheWrite: 2,
    }
    appendSample(s, path)
    const back = readSamples(path)
    assert.deepEqual(back, [s])
  })

  it("prunes old rows once the file passes the size floor", () => {
    const path = tmpFile()
    const old: Sample[] = []
    const now = Date.now()
    // Write a large file of expired rows directly to exceed the prune floor.
    for (let i = 0; i < 6000; i++) {
      old.push({
        at: now - RETENTION_MS - 1000,
        account: `acct-with-a-reasonably-long-name-${i}`,
        reqs: 1,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      })
    }
    writeFileSync(path, old.map((r) => JSON.stringify(r)).join("\n") + "\n")
    appendSample(
      {
        at: now,
        account: "fresh",
        reqs: 1,
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
      },
      path,
    )
    const back = readSamples(path)
    assert.equal(back.length, 1, "only the fresh row survives the prune")
    assert.equal(back[0]!.account, "fresh")
  })

  it("skips unparseable lines on read", () => {
    const path = tmpFile()
    writeFileSync(path, 'not json\n{"at":1,"account":"a","reqs":1}\n')
    assert.equal(readSamples(path).length, 1)
  })
})

// Regression: a test pointed HOME at a temp dir, restored it, and the exit
// flush then wrote its fixture rows into the real samples file.
describe("SampleAggregator target", () => {
  it("writes each bucket to the path current when it opened", () => {
    const out: Array<[string, string | undefined]> = []
    let where = "/tmp/a"
    const agg = new SampleAggregator(
      (s, p) => out.push([s.account, p]),
      () => where,
    )
    agg.observe({ at: 1_000, account: "x" })
    where = "/tmp/b"
    agg.observe({ at: 2_000, account: "x" })
    agg.flush()
    assert.deepEqual(out, [["x", "/tmp/a"]])
  })
})
