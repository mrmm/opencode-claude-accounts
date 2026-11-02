/**
 * A short cross-process lock for read-modify-write of a shared state file.
 *
 * tmp + rename stops a torn file but not a lost update: the server and the TUI
 * both read the whole file, change their entry and write it back, and the
 * slower writer drops the other's change. Holding `<path>.lock` across the
 * read and the write serialises them.
 *
 * Never blocks for long and never throws: after `waitMs` the work runs
 * unlocked, because a missed update is cheaper than a stalled request. A lock
 * left by a dead process, or older than LOCK_STALE_MS, is taken over.
 */
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs"

import { isStale, type LockInfo } from "../refresh-lock.ts"

const pause = new Int32Array(new SharedArrayBuffer(4))

export function withFileLock<T>(path: string, fn: () => T, waitMs = 500): T {
  const lock = `${path}.lock`
  const deadline = Date.now() + waitMs
  let held = false
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600)
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
      closeSync(fd)
      held = true
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") break
      let info: LockInfo | null = null
      try {
        info = JSON.parse(readFileSync(lock, "utf8")) as LockInfo
      } catch {}
      // A lock with no readable owner may be mid-write; only age clears it.
      if (info && isStale(info) && info.pid !== process.pid) {
        rmSync(lock, { force: true })
        continue
      }
      if (Date.now() >= deadline) break
      Atomics.wait(pause, 0, 0, 5)
    }
  }
  try {
    return fn()
  } finally {
    if (held) rmSync(lock, { force: true })
  }
}
