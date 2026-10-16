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

const SESSION_COLS =
  "select id, title, parent_id as parentId, tokens_input as input, tokens_output as output, " +
  "tokens_cache_read as cacheRead, tokens_cache_write as cacheWrite, cost, time_updated as updated "

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
  const sessions = [
    ...safe<StoreSession>(SESSION_COLS + "from session where time_updated > ?"),
    ...safe<StoreSession>(
      SESSION_COLS + "from session_v2 where time_updated > ?",
    ),
  ]
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
