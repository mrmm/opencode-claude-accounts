/**
 * The 7-day reads from OpenCode's own store, for the global token view.
 *
 * OpenCode 1 tables (session, part) and OpenCode 2 tables (session_v2,
 * session_message) live in the same file, and a store can have either or both.
 * Each read stands alone, so a missing table costs only its own rows.
 *
 * `all` runs one statement with the cutoff bound to `?`; the caller owns the
 * database handle (bun:sqlite in the TUI, node:sqlite in tests).
 */

import type { SessionRow } from "./tokens.ts"
import type { ToolCall } from "./traffic.ts"

export type StoreSession = SessionRow & { updated: number }

// Sums the window's own turns. A session's stored totals cover its whole lifetime, so summing
// those over-counted any long session, and a migrated session appears in both table sets.
const turnCols = (prefix: string) =>
  `sum(json_extract(m.data,'${prefix}.input')) as input, sum(json_extract(m.data,'${prefix}.output')) as output, ` +
  `sum(json_extract(m.data,'${prefix}.cache.read')) as cacheRead, sum(json_extract(m.data,'${prefix}.cache.write')) as cacheWrite, ` +
  "sum(json_extract(m.data,'$.cost')) as cost, max(m.time_created) as updated "

export function readStore(
  all: (sql: string, since: number) => unknown[],
  since: number,
) {
  const safe = <T>(sql: string): T[] => {
    try {
      return all(sql, since) as T[]
    } catch {
      return []
    }
  }
  const v2 = safe<StoreSession>(
    "select s.id, s.title, s.parent_id as parentId, " +
      turnCols("$.tokens") +
      "from session_message m join session_v2 s on s.id = m.session_id " +
      "where m.type = 'assistant' and m.time_created > ? group by s.id",
  )
  const seen = new Set(v2.map((s) => s.id))
  const v1 = safe<StoreSession>(
    "select s.id, s.title, s.parent_id as parentId, " +
      turnCols("$.tokens") +
      "from message m join session s on s.id = m.session_id " +
      "where json_extract(m.data,'$.role') = 'assistant' and m.time_created > ? group by s.id",
  ).filter((s) => !seen.has(s.id))
  const sessions = [...v1, ...v2]
  // shortcut: a full scan, ~1-2 s on a busy store; scan incrementally by rowid if the
  // pause on refresh is noticed.
  const calls = [
    ...safe<ToolCall>(
      "select json_extract(data,'$.tool') as tool, json_extract(data,'$.state.input.command') as command, " +
        "length(json_extract(data,'$.state.output')) as outBytes " +
        "from part where time_created > ? and json_extract(data,'$.type') = 'tool' " +
        "and json_extract(data,'$.state.status') = 'completed'",
    ),
    // V2 keeps tool calls inside the assistant message; output is the JSON of its
    // content array, a few bytes over the text itself.
    ...safe<ToolCall>(
      "select json_extract(c.value,'$.name') as tool, json_extract(c.value,'$.state.input.command') as command, " +
        "length(json_extract(c.value,'$.state.content')) as outBytes " +
        "from session_message m, json_each(m.data,'$.content') c " +
        "where m.type = 'assistant' and m.time_created > ? " +
        "and json_extract(c.value,'$.type') = 'tool' and json_extract(c.value,'$.state.status') = 'completed'",
    ),
  ]
  return { sessions, calls }
}
