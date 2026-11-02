/**
 * A week of usage, compact enough to keep.
 *
 * The request log (`usage.ts`) rotates after a couple of megabytes — under a
 * day of traffic — which is fine for "what just happened" and useless for a
 * forecast that needs a trailing week. This is the long memory: one row per
 * account per 5-minute bucket, carrying the utilisation gauge and the token
 * totals for that slice. Eight days of those is a few hundred kilobytes.
 *
 * Split in two the way the rest of the domain is: a pure aggregator that folds
 * request observations into buckets and prunes old ones, and a thin writer that
 * owns the file. The aggregator holds the live bucket in memory and emits a row
 * only when the bucket rolls over (or on flush/exit), so steady traffic costs
 * no I/O until the bucket closes.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const BUCKET_MS = 5 * 60_000
export const RETENTION_MS = 8 * 24 * 60 * 60_000

/** One account's traffic over one 5-minute bucket. */
export type Sample = {
  /** Bucket start, epoch ms. */
  at: number
  account: string
  /** Last 5h utilisation seen in the bucket (gauge, newest wins). */
  u5?: number
  /** Last 7d utilisation seen in the bucket. */
  u7?: number
  reqs: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** One request's contribution to a sample. */
export type Observation = {
  at: number
  account: string
  u5?: number
  u7?: number
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

export function bucketStart(ms: number): number {
  return Math.floor(ms / BUCKET_MS) * BUCKET_MS
}

/**
 * Folds observations into per-(account, bucket) samples held in memory, and
 * emits a completed sample when its bucket closes.
 *
 * `onFlush` is the only side-effecting seam; the fold itself is pure. Keyed by
 * `account|bucket`, so two accounts in the same bucket stay separate rows and
 * the same account across two buckets flushes the older one.
 */
export class SampleAggregator {
  private live = new Map<string, Sample>()
  /** Where each live bucket goes, fixed when the bucket opens. */
  private targets = new Map<string, string>()
  private readonly onFlush: (s: Sample, path?: string) => void
  private readonly target: (() => string) | undefined
  /**
   * `target` is read when a bucket opens, not when it flushes: the exit flush
   * runs after HOME may have changed (a test restoring it), and must not write
   * that bucket into a different user's data.
   */
  constructor(
    onFlush: (s: Sample, path?: string) => void,
    target?: () => string,
  ) {
    this.onFlush = onFlush
    this.target = target
  }

  private emit(key: string, s: Sample): void {
    const path = this.targets.get(key)
    this.targets.delete(key)
    if (path === undefined) this.onFlush(s)
    else this.onFlush(s, path)
  }

  private key(account: string, bucket: number): string {
    return `${account}|${bucket}`
  }

  observe(o: Observation): void {
    const bucket = bucketStart(o.at)
    const k = this.key(o.account, bucket)

    // Any bucket older than this observation's is complete: flush and drop it.
    // Covers the common case (time moving forward) without a timer.
    for (const [key, s] of this.live) {
      if (s.account === o.account && s.at < bucket) {
        this.emit(key, s)
        this.live.delete(key)
      }
    }

    let s = this.live.get(k)
    if (!s) {
      s = {
        at: bucket,
        account: o.account,
        reqs: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      }
      this.live.set(k, s)
      if (this.target) this.targets.set(k, this.target())
    }
    s.reqs += 1
    s.input += o.input ?? 0
    s.output += o.output ?? 0
    s.cacheRead += o.cacheRead ?? 0
    s.cacheWrite += o.cacheWrite ?? 0
    if (o.u5 !== undefined) s.u5 = o.u5
    if (o.u7 !== undefined) s.u7 = o.u7
  }

  /** Emit every live bucket and clear. Call on interval and at exit. */
  flush(): void {
    for (const [key, s] of this.live) this.emit(key, s)
    this.live.clear()
  }
}

export function samplesPath(): string {
  return join(
    homedir(),
    ".local",
    "share",
    "opencode",
    "claude-auth-samples.jsonl",
  )
}

/**
 * Keep only rows newer than the retention window.
 *
 * Pure: takes rows, returns the survivors. The writer calls it on every append
 * so the file self-trims, which is cheap because the file is small by design.
 */
export function prune(rows: Sample[], nowMs: number): Sample[] {
  const cutoff = nowMs - RETENTION_MS
  return rows.filter((r) => r.at >= cutoff)
}

/** Read samples back, skipping anything unparseable. */
export function readSamples(path: string = samplesPath()): Sample[] {
  const out: Sample[] = []
  let text: string
  try {
    text = readFileSync(path, "utf-8")
  } catch {
    return out
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      const s = JSON.parse(line) as Sample
      if (typeof s?.at === "number") out.push(s)
    } catch {
      continue
    }
  }
  return out
}

/**
 * Append one sample and prune in the same pass. Never throws: runs on the
 * request path via the aggregator's flush.
 *
 * Pruning means a read-rewrite rather than a bare append, so it only kicks in
 * once the file crosses a cheap size floor — most appends stay O(1).
 */
const PRUNE_FLOOR_BYTES = 256 * 1024

export function appendSample(s: Sample, path: string = samplesPath()): void {
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    let size = 0
    try {
      size = statSync(path).size
    } catch {
      // no file yet
    }

    if (size > PRUNE_FLOOR_BYTES) {
      const kept = prune(readSamples(path), Date.now())
      kept.push(s)
      const tmp = `${path}.tmp`
      appendFileSync(
        tmp,
        kept.map((r) => JSON.stringify(r)).join("\n") + "\n",
        {
          flag: "w",
        },
      )
      renameSync(tmp, path)
      return
    }

    appendFileSync(path, `${JSON.stringify(s)}\n`, "utf-8")
  } catch {
    // Non-fatal by design.
  }
}
