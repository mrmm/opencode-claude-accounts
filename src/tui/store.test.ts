import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { describe, it } from "node:test"

import { readStore } from "./store.ts"

const db = (sql: string) => {
  const d = new DatabaseSync(":memory:")
  d.exec(sql)
  return (q: string, since: number) => d.prepare(q).all(since)
}
const tables = `
  create table session (id text, title text, parent_id text);
  create table session_v2 (id text, title text, parent_id text);
  create table message (session_id text, time_created int, data text);
  create table part (time_created int, data text);
  create table session_message (session_id text, type text, time_created int, data text);
`
const turn = (cost: number, read: number) =>
  JSON.stringify({
    role: "assistant",
    cost,
    tokens: { input: 1, output: 2, cache: { read, write: 0 } },
  })

describe("readStore", () => {
  it("sums only the window's turns, and a migrated session once", () => {
    const all = db(`${tables}
      insert into session values ('a','old',null), ('m','migrated',null);
      insert into session_v2 values ('b','new','a'), ('m','migrated',null);
      insert into message values ('a', 500, '${turn(0.1, 10)}'), ('a', 50, '${turn(9, 999)}'), ('m', 500, '${turn(5, 5)}');
      insert into session_message values ('b','assistant',600,'${turn(0.2, 20)}'), ('b','assistant',700,'${turn(0.3, 30)}'), ('m','assistant',600,'${turn(0.4, 40)}'), ('b','user',600,'{}');
      insert into part values (500, '{"type":"tool","tool":"read","state":{"status":"completed","output":"abcd"}}');
      insert into session_message values ('b','assistant', 600, '{"content":[{"type":"tool","name":"shell","state":{"status":"completed","input":{"command":"git log"},"content":[{"type":"text","text":"hi"}]}}]}');
    `)
    const { sessions, calls } = readStore(all, 100)
    const byId = Object.fromEntries(sessions.map((s) => [s.id, s]))
    assert.deepEqual(Object.keys(byId).sort(), ["a", "b", "m"])
    assert.equal(byId.a!.cost, 0.1) // the turn before the window is not counted
    assert.equal(byId.a!.cacheRead, 10)
    assert.equal(Math.round(byId.b!.cost * 10) / 10, 0.5)
    assert.equal(byId.b!.parentId, "a")
    assert.equal(byId.m!.cost, 0.4) // V2 wins over the V1 copy
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
      `create table session_v2 (id text, title text, parent_id text);
       create table session_message (session_id text, type text, time_created int, data text);
       insert into session_v2 values ('b','new',null);
       insert into session_message values ('b','assistant',600,'${turn(0.2, 20)}');`,
    )
    const { sessions, calls } = readStore(all, 100)
    assert.equal(sessions.length, 1)
    assert.deepEqual(calls, [])
  })
})
