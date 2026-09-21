/**
 * One block of text that answers "what is this plugin actually doing".
 *
 * Exists because the alternative was a screenshot and a guess. Three of the
 * last several rounds were spent establishing facts this prints for free: that
 * the running build predated the fix, that the quota cache held no
 * extra-usage data, that a preset reference resolved to nothing.
 *
 * Every line is a FACT READ AT CALL TIME, never a restatement of intent: what
 * the build is, what the cache holds, what resolved and what did not. A debug
 * dump that reports what the code meant to do is worth nothing.
 */
import { type QuotaCache } from "../balance/quota.ts"
import { type Preset } from "./presets.ts"

export type DebugInput = {
  build: string
  selection: string
  accounts: readonly { source: string; label?: string }[]
  quota: QuotaCache
  presets: Record<string, Preset>
  config: Record<string, unknown>
  now?: number
  /** Sources a preset names that resolve to no account. */
  unresolved?: string[]
  denials?: string[]
}

const age = (then: number | undefined, now: number) =>
  then === undefined ? "never" : `${Math.round((now - then) / 60)}m ago`

const pct = (u: number | undefined) =>
  u === undefined ? "--" : `${Math.round(u * 100)}%`

const money = (minor: number | undefined, cur: string | undefined) =>
  minor === undefined ? "--" : `${(minor / 100).toFixed(2)} ${cur ?? ""}`.trim()

/** Plain text, because it is going to be pasted somewhere. */
export function debugReport(input: DebugInput): string {
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const out: string[] = []
  const say = (s = "") => out.push(s)

  say(`build       ${input.build}`)
  say(`selection   ${input.selection}`)
  say(`accounts    ${input.accounts.length} in the Keychain`)
  if (input.denials?.length) {
    say(`declining   ${input.denials.length} session(s) have refused credits`)
  }
  say()

  say("ACCOUNTS")
  for (const a of input.accounts) {
    const q = input.quota[a.source]
    say(`  ${a.label ?? a.source}`)
    say(`    source    ${a.source}`)
    if (!q) {
      // The single most useful line here: no reading at all is a different
      // problem from a bad reading, and they look identical in the sidebar.
      say("    quota     no reading — never observed, or expired out of cache")
      continue
    }
    say(
      `    5h ${pct(q.fiveHour?.utilization)}  wk ${pct(q.sevenDay?.utilization)}` +
        `  observed ${age(q.observedAt, now)}`,
    )
    say(
      `    status    5h=${q.fiveHour?.status ?? "--"}` +
        ` wk=${q.sevenDay?.status ?? "--"}` +
        ` representative=${q.representative ?? "--"}`,
    )
    if (q.extra) {
      say(
        `    credits   enabled=${q.extra.enabled} capReached=${q.extra.capReached}` +
          ` spent=${money(q.extra.usedMinor, q.extra.currency)}` +
          ` of ${money(q.extra.limitMinor, q.extra.currency)}`,
      )
    } else {
      // Its absence is the story: no probe has landed, so every credits-aware
      // decision is running blind.
      say(
        "    credits   UNKNOWN — the usage probe has not landed for this account",
      )
    }
    for (const l of q.activeLimits ?? []) {
      say(`    binding   ${l.kind} at ${l.percent}% (${l.severity})`)
    }
  }
  say()

  say("PRESETS")
  for (const [name, p] of Object.entries(input.presets)) {
    const tiers = Array.isArray(p.pools) ? p.pools : null
    say(
      `  ${name}${tiers ? ` — ${tiers.length} tiers` : ` — ${(p.accounts ?? []).length} accounts`}` +
        `${p.strategy ? ` (${p.strategy})` : ""}`,
    )
    if (tiers) {
      tiers.forEach((t, i) =>
        say(
          `    ${i + 1}. ${t.name}: ${(t.accounts ?? []).join(", ") || "empty"}`,
        ),
      )
    }
  }
  if (input.unresolved?.length) {
    say()
    say("UNRESOLVED REFERENCES")
    // Silently dropped by the balancer, which is how a three-account preset
    // becomes a two-account one without saying so.
    for (const ref of input.unresolved) say(`  ${ref} — matches no account`)
  }
  say()

  say("CONFIG (the keys that decide routing)")
  for (const [k, v] of Object.entries(input.config)) {
    say(`  ${k} = ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
  }
  return out.join("\n")
}
