/**
 * One view of everything the balancer knows.
 *
 *   pnpm dash            current state
 *   pnpm dash -- 7d      widen the usage window
 *   pnpm dash -- --watch refresh every few seconds
 *
 * Exists because the state that decides which account serves a request is
 * spread across four places — the selection file, the config, the quota cache
 * and the usage log — and a question like "why did it refuse an account that
 * plainly has quota" can only be answered by reading them together. It shows
 * BOTH rate-limit windows, because a five-hour limit can be full while the
 * weekly budget is barely touched, and seeing only one of them is what makes a
 * correct refusal look like a bug.
 *
 * Read-only. It never changes a selection or touches a credential.
 */
import {
  assess,
  resolvePools,
  selectAccount,
} from "../dist/balance/balancer.js"
import { readQuotaCache } from "../dist/balance/quota.js"
import {
  credentialState,
  describeSelection,
  resolveActiveConfig,
} from "../dist/balance/rotate.js"
import { readUsage, summarize, usagePath } from "../dist/balance/usage.js"
import { getConfig, resetConfigCache } from "../dist/config.js"
import { loadPersistedAccountSource } from "../dist/credentials.js"
import { readAllClaudeAccounts } from "../dist/keychain.js"

const args = process.argv.slice(2)
const watch = args.includes("--watch")
const windowSpec = args.find((a) => /^\d+[smhd]$/.test(a)) ?? "24h"

const UNITS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}
const windowMs =
  Number.parseInt(windowSpec, 10) * (UNITS[windowSpec.slice(-1)] ?? UNITS.h!)

const BAR = 24
const bar = (v: number | undefined): string => {
  if (v === undefined) return "?".padEnd(BAR)
  const filled = Math.max(0, Math.min(BAR, Math.round(v * BAR)))
  return "#".repeat(filled) + "-".repeat(BAR - filled)
}
const pct = (v: number | undefined) =>
  v === undefined ? "  ?" : `${Math.round(v * 100)}%`.padStart(4)
const mins = (sec: number | undefined, now: number) =>
  sec === undefined
    ? "    -"
    : `${Math.max(0, Math.round((sec - now) / 60))}m`.padStart(5)

function render(): void {
  resetConfigCache()
  const raw = readAllClaudeAccounts()
  const persisted = loadPersistedAccountSource()
  const { cfg, preset } = resolveActiveConfig(getConfig(), persisted)
  const members = raw.map((a) => ({
    source: a.source,
    label: a.label,
    credential: credentialState(a),
  }))
  const cache = readQuotaCache()
  const now = Math.floor(Date.now() / 1000)
  const health = new Map(assess(members, cache, cfg).map((h) => [h.source, h]))

  // Match what the decision actually uses: a window past its reset counts as
  // empty, so printing its stale 101% beside a "usable" verdict on the same line
  // would contradict itself — which is the confusion this view exists to end.
  const effective = (
    w: { utilization: number; resetsAt?: number } | undefined,
  ): number | undefined =>
    w === undefined
      ? undefined
      : w.resetsAt !== undefined && w.resetsAt <= now
        ? 0
        : w.utilization
  const pools = resolvePools(members, cfg)
  const inPlay = new Set(pools.flatMap((p) => p.accounts))

  const out: string[] = []
  out.push("")
  out.push(
    `  selection   ${describeSelection(cfg, persisted)}${preset ? `  [${preset}]` : ""}`,
  )
  out.push(
    `  policy      autoSwitch=${cfg.autoSwitch}  strategy=${cfg.strategy}  switchAt=${Math.round(cfg.switchAt * 100)}% of ${cfg.switchWindow}  on429=${cfg.switchOn429}`,
  )
  out.push(
    `              bindBy=${cfg.bindBy}  pinBlocksRotation=${cfg.pinBlocksRotation}`,
  )
  out.push("")

  // Both windows, always. Showing only the binding one is what makes a spent
  // 5-hour window look like "no quota at all".
  out.push(
    "  ACCOUNT                        5h window            weekly window        verdict",
  )
  for (const m of members) {
    const h = health.get(m.source)
    const q = cache[m.source]
    const f = q?.fiveHour
    const s = q?.sevenDay
    const live = inPlay.has(m.source)
    const mark = live ? (h?.healthy ? "+" : "!") : " "
    const name = (m.label ?? m.source).slice(0, 28).padEnd(28)
    const verdict = h?.healthy ? "usable" : (h?.reason ?? "not in pool")
    out.push(
      `  ${mark} ${name} ${pct(effective(f))} ${bar(effective(f))}${mins(f?.resetsAt, now)} ${pct(effective(s))} ${bar(effective(s))}${mins(s?.resetsAt, now)}  ${verdict}`,
    )
  }
  out.push("")
  out.push(
    `  + in the active pool and usable   ! in the pool but not usable   (blank) not in this preset`,
  )
  out.push("")

  for (const p of pools) {
    out.push(
      `  pool "${p.name}" (${p.strategy ?? cfg.strategy}): ${p.accounts.map((a) => a.slice(-8)).join(", ")}`,
    )
  }

  const decision = selectAccount(members, cache, cfg, null)
  if (decision) {
    const flag =
      decision.pool === "exhausted"
        ? "EXHAUSTED"
        : decision.pool === "over-threshold"
          ? "DEGRADED"
          : "OK"
    out.push(
      `  next request -> ${decision.source.slice(-8)}  [${flag}]  ${decision.reason}`,
    )
  } else {
    out.push("  next request -> no account could be selected")
  }
  out.push("")

  const since = Date.now() - windowMs
  const usage = summarize(readUsage(since), since)
  const total = usage.accounts.reduce((n, a) => n + a.requests, 0)
  out.push(
    `  USAGE, last ${windowSpec}: ${total} requests, ${usage.rotations} rotations`,
  )
  if (total > 0) {
    for (const a of usage.accounts) {
      const share = a.requests / total
      out.push(
        `    ${a.account.slice(-8)} ${String(a.requests).padStart(5)} ${pct(share)} ${bar(share)}  429:${String(a.refusals).padStart(3)}  err:${String(a.errors).padStart(3)}  avg:${a.avg_duration_ms}ms`,
      )
    }
    const triggers = Object.entries(usage.by_trigger)
    if (triggers.length > 0) {
      out.push(
        `    rotations by trigger: ${triggers.map(([t, n]) => `${t}=${n}`).join("  ")}`,
      )
    }
  }
  out.push("")
  out.push(`  log: ${usagePath()}`)
  out.push("")

  if (watch) process.stdout.write("\u001b[2J\u001b[H")
  console.log(out.join("\n"))
}

render()
if (watch) setInterval(render, 5000)
