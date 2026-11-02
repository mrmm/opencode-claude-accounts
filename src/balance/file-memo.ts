/**
 * Parse a small JSON state file only when it changed.
 *
 * The request path reads the quota cache and the per-session opt-in files
 * several times per request; each is rewritten far less often than it is read.
 * A stat (inode, size, mtime in ns) decides whether the parsed value is still
 * current. Every writer of these files uses tmp + rename, which always yields a
 * new inode, so a write by the other process (server vs TUI) is never missed.
 *
 * The returned value is shared between callers: treat it as read-only.
 */
import { readFileSync, statSync } from "node:fs"

type Stamp = { ino: bigint; size: bigint; mtimeNs: bigint }
const memo = new Map<string, { stamp: Stamp; value: unknown }>()

const stampOf = (path: string): Stamp => {
  const s = statSync(path, { bigint: true })
  return { ino: s.ino, size: s.size, mtimeNs: s.mtimeNs }
}

const same = (a: Stamp, b: Stamp) =>
  a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs

/**
 * `parse(JSON.parse(text))` for `path`, re-read only when its stamp moved.
 * Missing or unreadable file, or a parse that throws, gives `fallback`.
 */
export function readJsonFresh<T>(
  path: string,
  parse: (raw: unknown) => T,
  fallback: T,
): T {
  try {
    const stamp = stampOf(path)
    const hit = memo.get(path)
    if (hit && same(hit.stamp, stamp)) return hit.value as T
    const value = parse(JSON.parse(readFileSync(path, "utf8")))
    memo.set(path, { stamp, value })
    return value
  } catch {
    memo.delete(path)
    return fallback
  }
}

/** After writing `path` with `value`, record it so the next read skips the parse. */
export function primeJsonFresh(path: string, value: unknown): void {
  try {
    memo.set(path, { stamp: stampOf(path), value })
  } catch {
    memo.delete(path)
  }
}

/** Test seam. */
export function resetJsonFresh(): void {
  memo.clear()
}
