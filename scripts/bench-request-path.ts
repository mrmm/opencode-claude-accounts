/**
 * Time the bookkeeping every proxied request pays, against throwaway files of
 * realistic size: a quota cache with 10 accounts, a ~5 MB usage log, reserve
 * and denial files with a few sessions. Never touches the real data directory.
 *
 *   node --experimental-strip-types scripts/bench-request-path.ts [iterations]
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = mkdtempSync(join(tmpdir(), "bench-request-path-"))
process.env.HOME = home
process.env.XDG_DATA_HOME = join(home, ".local", "share")
process.env.XDG_CONFIG_HOME = join(home, ".config")
const data = join(home, ".local", "share", "opencode")
mkdirSync(data, { recursive: true })

const N = Number(process.argv[2] ?? 2000)
const ACCOUNTS = Array.from({ length: 10 }, (_, i) => `acme-${i + 1}`)
const now = Math.floor(Date.now() / 1000)

const window = (u: number) => ({
  utilization: u,
  resetsAt: now + 3600,
  status: "allowed",
})
writeFileSync(
  join(data, "claude-auth-quota.json"),
  JSON.stringify(
    Object.fromEntries(
      ACCOUNTS.map((a, i) => [
        a,
        {
          fiveHour: window(i / 10),
          sevenDay: window(i / 20),
          observedAt: now,
          extra: { enabled: true, monthlyLimit: 20000, usedCredits: 100 },
        },
      ]),
    ),
    null,
    2,
  ),
)
const sessions = Object.fromEntries(
  Array.from({ length: 20 }, (_, i) => [`ses_${i}`, Date.now()]),
)
writeFileSync(
  join(data, "claude-auth-reserve-allows.json"),
  JSON.stringify(sessions),
)
writeFileSync(
  join(data, "claude-auth-credit-denials.json"),
  JSON.stringify(sessions),
)

// ~5 MB of request rows spread over the last 24h.
const lines: string[] = []
let bytes = 0
for (let i = 0; bytes < 5 * 1024 * 1024; i++) {
  const line = JSON.stringify({
    kind: "request",
    timestamp: new Date().toISOString(),
    created_at: Date.now() - (i % 86_000) * 1000,
    account: ACCOUNTS[i % 10],
    model: "claude-opus-5-5",
    session: `ses_${i % 50}`,
    status: 200,
    duration_ms: 900,
    utilization_5h: 0.4,
    utilization_7d: 0.2,
    ttl: "5m",
    input: 12,
    output: 400,
    cacheRead: 90_000,
    cacheWrite: 2_000,
    cacheWrite1h: 0,
  })
  lines.push(line)
  bytes += line.length + 1
}
const usageFile = join(data, "claude-auth-usage.jsonl")
writeFileSync(usageFile, `${lines.join("\n")}\n`)

const { getConfig } = await import("../src/config.ts")
const { accountKey } = await import("../src/balance/account-key.ts")
const { quotaForAccount, readQuotaCache, writeQuotaForAccount } =
  await import("../src/balance/quota.ts")
const { creditsDenied, reserveAllowed } =
  await import("../src/balance/sessions.ts")
const { currentUsageIndex, record, resetUsageCache } =
  await import("../src/balance/usage.ts")
const { SampleAggregator } = await import("../src/balance/samples.ts")

function time(label: string, fn: (i: number) => void, n = N): void {
  for (let i = 0; i < Math.min(50, n); i++) fn(i)
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < n; i++) fn(i)
  const us = Number(process.hrtime.bigint() - t0) / 1000 / n
  console.log(`${label.padEnd(36)} ${us.toFixed(1).padStart(9)} µs/call`)
}

console.log(`iterations ${N}; usage log ${(bytes / 1048576).toFixed(1)} MB`)
time("getConfig", () => getConfig())
time("accountKey", (i) => accountKey(ACCOUNTS[i % 10]!))
time("readQuotaCache", () => readQuotaCache())
time("readQuotaCache + quotaForAccount", (i) =>
  quotaForAccount(ACCOUNTS[i % 10]!, readQuotaCache()),
)
time("reserveAllowed", (i) => reserveAllowed(`ses_${i % 30}`))
time("creditsDenied", (i) => creditsDenied(`ses_${i % 30}`))
time("writeQuotaForAccount", (i) =>
  writeQuotaForAccount(ACCOUNTS[i % 10]!, {
    fiveHour: window(0.5),
    observedAt: now,
  } as never),
)
const agg = new SampleAggregator(() => {})
time("SampleAggregator.observe", (i) =>
  agg.observe({ at: Date.now(), account: ACCOUNTS[i % 10]!, u5: 0.4 }),
)
time(
  "record (usage append)",
  (i) =>
    record({
      kind: "request",
      timestamp: "",
      created_at: Date.now(),
      account: ACCOUNTS[i % 10]!,
      model: "m",
      status: 200,
      duration_ms: 1,
    } as never),
  Math.min(N, 500),
)
time(
  "currentUsageIndex (cold, 24h scan)",
  () => {
    resetUsageCache()
    currentUsageIndex()
  },
  Math.min(N, 10),
)
time("currentUsageIndex (warm)", () => currentUsageIndex())
time(
  "currentUsageIndex (TTL refresh, 1 new row)",
  (i) => {
    record({
      kind: "request",
      timestamp: "",
      created_at: Date.now(),
      account: ACCOUNTS[i % 10]!,
      model: "m",
      status: 200,
      duration_ms: 1,
    } as never)
    currentUsageIndex(24 * 60 * 60_000, 0)
  },
  Math.min(N, 200),
)
