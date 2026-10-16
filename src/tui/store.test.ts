import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { describe, it } from "node:test"

import { readStore } from "./store.ts"

const db = (sql: string) => {
  const d = new DatabaseSync(":memory:")
  d.exec(sql)
  return (q: string, since: number) => d.prepare(q).all(since)
}
const cols =
  "id text, title text, parent_id text, tokens_input int, tokens_output int, tokens_cache_read int, tokens_cache_write int, cost real, time_updated int"

describe("readStore", () => {
  it("reads OpenCode 1 and 2 tables together", () => {
    const all = db(`
      create table session (${cols});
      create table session_v2 (${cols});
      create table part (time_created int, data text);
      create table session_message (type text, time_created int, data text);
      insert into session values ('a','old',null,1,1,10,0,0.1,500);
      insert into session_v2 values ('b','new','a',1,1,20,0,0.2,600);
      insert into session_v2 values ('c','stale',null,1,1,99,0,0.2,50);
      insert into part values (500, '{"type":"tool","tool":"read","state":{"status":"completed","output":"abcd"}}');
      insert into session_message values ('assistant', 600, '{"content":[{"type":"text","text":"x"},{"type":"tool","name":"shell","state":{"status":"completed","input":{"command":"git log"},"content":[{"type":"text","text":"hi"}]}}]}');
    `)
    const { sessions, calls } = readStore(all, 100)
    assert.deepEqual(
      sessions.map((s) => s.id),
      ["a", "b"],
    )
    assert.equal(sessions[1]!.parentId, "a")
    assert.deepEqual(
      calls.map((c) => [c.tool, c.command ?? null, c.outBytes > 0]),
      [
        ["read", null, true],
        ["shell", "git log", true],
      ],
    )
  })

  it("survives a store with only the OpenCode 2 tables", () => {
    const all = db(
      `create table session_v2 (${cols}); insert into session_v2 values ('b','new',null,1,1,20,0,0.2,600);`,
    )
    const { sessions, calls } = readStore(all, 100)
    assert.equal(sessions.length, 1)
    assert.deepEqual(calls, [])
  })
})
