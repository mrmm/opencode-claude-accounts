/**
 * Tools the plugin registers with OpenCode.
 *
 * These are the `pnpm lb` / `pnpm usage` surfaces, reachable from inside a
 * session: they read and write the same selection file and usage log, so there
 * is one mechanism with two front doors rather than two implementations.
 *
 * They register through the plugin's own `tool` hook rather than a separate MCP
 * server. An MCP server would be a second process, its own lifecycle and its own
 * entry in `opencode.jsonc`, to expose functions that already live in this
 * process and read this plugin's state — the extra hop buys nothing.
 *
 * Two consequences worth being deliberate about, because they cut against
 * keeping the balancer invisible:
 *
 *   - every tool's description is in the model's context for the whole session,
 *   - the agent can call them, so it can move accounts on its own.
 *
 * Neither is free, which is why `"tools": false` turns the whole set off and
 * leaves the CLI. Selecting through these tools is still transparent in the way
 * that matters: it writes a file, so nothing is re-registered and nothing in
 * flight is cancelled — unlike choosing in `opencode auth login`.
 */

import { tool } from "@opencode-ai/plugin"
import { z } from "zod"

import { assess, orderByConfig, resolveRef } from "../balance/balancer.ts"
import { ceilingFor } from "../balance/caps.ts"
import { cacheBreakdown, cacheImpact } from "../balance/cache-stats.ts"
import { requestsFromUsage, toCacheRows } from "../tui/caps-ui.ts"
import {
  allowReserve,
  boundSource,
  reserveAllowed,
  revokeReserve,
} from "../balance/sessions.ts"
import { log } from "../logger.ts"
import { accountKey } from "../balance/account-key.ts"
import { getConfig } from "../config.ts"
import {
  AUTO_SOURCE,
  PRESET_PREFIX,
  getActiveAccount,
  listAccounts,
  loadPersistedAccountSource,
  saveAccountSource,
} from "../credentials.ts"
import {
  formatQuotaPrefix,
  quotaEntry,
  readQuotaCache,
} from "../balance/quota.ts"
import {
  cacheAccountLines,
  cacheSessionLines,
  parseWindowMs,
  reserveRefusal,
} from "./tools-format.ts"
import {
  credentialState,
  maybeRotate,
  resolveActiveConfig,
} from "../balance/rotate.ts"
import { currentUsageIndex, readUsage, summarize } from "../balance/usage.ts"
import { groupRows } from "../tui/groups.ts"

const members = () =>
  listAccounts().map((a) => ({ source: a.source, label: a.label }))

function describeSelection(value: string | null): string {
  const cfg = getConfig()
  if (!value) return "none — the config decides"
  if (value === AUTO_SOURCE) return `auto (${cfg.strategy})`
  if (value.startsWith(PRESET_PREFIX)) {
    const name = value.slice(PRESET_PREFIX.length)
    const p = cfg.presets[name]
    return p
      ? `preset "${p.label ?? name}" (${p.strategy ?? cfg.strategy})`
      : `preset "${name}" — NOT DEFINED, so it is ignored`
  }
  return `pinned to ${members().find((m) => m.source === value)?.label ?? value}`
}

const pct = (n: number) => `${Math.round(n * 100)}%`

export const claudeAuthTools = {
  claude_auth_status: tool({
    description:
      "Report which Claude account is serving requests right now, what is selected (a preset, auto, or a pin), each account's quota, its usage ceiling and reserved state, whether this session may spend reserved quota, and whether automatic rotation is enabled. Read-only.",
    args: {},
    async execute(_args, ctx) {
      const selection = loadPersistedAccountSource()
      const { cfg, preset } = resolveActiveConfig(getConfig(), selection)
      const active = getActiveAccount()
      const quota = readQuotaCache()
      const overrideOn = ctx?.sessionID ? reserveAllowed(ctx.sessionID) : false

      // The balancer's own verdict, so this reports what would actually happen
      // rather than a figure the reader has to re-apply the rules to.
      const health = new Map(
        assess(
          listAccounts().map((a) => ({
            source: a.source,
            label: a.label,
            id: accountKey(a.source),
            credential: credentialState(a),
          })),
          quota,
          cfg,
        ).map((h) => [h.source, h]),
      )

      // Sessions bind to their own account; the process-wide active one is only
      // what an unbound request would get.
      const bound = ctx?.sessionID ? boundSource(ctx.sessionID) : undefined
      const servingSource = bound ?? active?.source
      const serving = members().find((m) => m.source === servingSource)
      const nameOf = (source: string, label?: string) =>
        cfg.accountIds[accountKey(source)]?.name ?? label ?? source

      const day = toCacheRows(
        requestsFromUsage(readUsage(Date.now() - 24 * 60 * 60_000)),
      )
      const ci = cacheImpact(day)
      const misses = Object.entries(ci.byCause)
        .map(([c, v]) => `${c} ${v.n}`)
        .join(", ")

      const lines = [
        `serving now: ${serving ? `${accountKey(serving.source)} (${nameOf(serving.source, serving.label)})${bound ? " — bound to this session" : ""}` : "none"}`,
        `selection:   ${describeSelection(selection)}`,
        `strategy:    ${cfg.strategy}${preset ? ` (from preset "${preset}")` : ""}`,
        `autoSwitch:  ${cfg.autoSwitch} — moves by itself at ${Math.round(cfg.switchAt * 100)}% of ${cfg.switchWindow}, on429 ${cfg.switchOn429}`,
        `caps:        capMode ${cfg.capMode}; this session may spend reserved quota: ${overrideOn}`,
        `cache 24h:   ${ci.requests ? `${pct(ci.hitRate)} hit, saves ${pct(ci.saved)} of input cost over ${ci.requests} req; misses: ${misses || "none"}` : "no requests with token data"}`,
        `optimise:    cacheTtl ${cfg.cacheTtl} (1h on ${ci.ttl1h.requests} req); contextEditing ${cfg.contextEditing ? "on" : "off"} (applied ${ci.contextEdited} req); bindBy ${cfg.bindBy} — change with /cc-cache or /cc-config`,
        "",
        "accounts (* = serving this session):",
      ]

      const ceilingLabel = (id: string): string => {
        const c5 = ceilingFor(cfg, id, "5h")
        const c7 = ceilingFor(cfg, id, "7d")
        if (c5 >= 1 && c7 >= 1) return ""
        const parts: string[] = []
        if (c5 < 1) parts.push(`5h<=${Math.round(c5 * 100)}%`)
        if (c7 < 1) parts.push(`7d<=${Math.round(c7 * 100)}%`)
        return ` ceiling ${parts.join(" ")}`
      }

      for (const m of orderByConfig(members(), cfg.accounts, cfg.groups)) {
        const h = health.get(m.source)
        const verdict = h?.reserved
          ? `reserved — ${h.reason}`
          : h?.healthy
            ? "usable"
            : `unusable — ${h?.reason ?? "?"}`
        lines.push(
          `  ${m.source === servingSource ? "*" : " "} ${accountKey(m.source).padEnd(16)} ${nameOf(m.source, m.label).padEnd(32)} ${(formatQuotaPrefix(quotaEntry(quota, m.source)) || "[no reading]").padEnd(16)} ${verdict}${ceilingLabel(accountKey(m.source))}`,
        )
      }

      const groups = groupRows({
        groups: cfg.groups,
        accounts: orderByConfig(members(), cfg.accounts, cfg.groups).map(
          (m) => ({ source: m.source, label: m.label ?? m.source }),
        ),
        quota,
        requests: Object.fromEntries(
          Object.entries(currentUsageIndex()).map(([k, v]) => [k, v.requests]),
        ),
        resolve: (ref) => resolveRef(ref, members()),
        thresholds: {
          warnAt: cfg.quotaWarnAt,
          weeklyWarnAt: cfg.quotaWeeklyWarnAt,
        },
      })
      if (groups.length > 0) {
        lines.push("", "groups (room in accounts; worst state):")
        for (const g of groups) {
          lines.push(
            `  ${g.title.padEnd(16)} ${`${g.count}  ${g.summary}  ${g.share}`.padEnd(48)} ${g.health.padEnd(8)} ${g.sources.map((s) => accountKey(s)).join(", ") || "(no live account)"}`,
          )
        }
      }

      if (ci.requests > 0) {
        const b = cacheBreakdown(day)
        const order = orderByConfig(members(), cfg.accounts, cfg.groups).map(
          (m) => accountKey(m.source),
        )
        const sessions = cacheSessionLines(b)
        lines.push(
          "",
          "cache by account, 24h (share of input read from cache):",
          ...cacheAccountLines(
            b,
            order,
            (id) => cfg.accountIds[id]?.name ?? "",
          ),
          "",
          "sessions with the most cache misses, 24h:",
          ...(sessions.length ? sessions : ["  none"]),
        )
      }

      const presets = Object.entries(cfg.presets)
      if (presets.length > 0) {
        lines.push("", "presets:")
        for (const [name, p] of presets) {
          const n = p.pools
            ? p.pools.reduce((t, x) => t + x.accounts.length, 0)
            : (p.accounts?.length ?? 0)
          lines.push(
            `  ${name.padEnd(20)} ${(p.strategy ?? cfg.strategy).padEnd(13)} ${n} accounts`,
          )
        }
      }

      return lines.join("\n")
    },
  }),

  claude_auth_select: tool({
    description:
      'Choose which Claude account serves requests: a preset name, an account (exact Keychain source or a unique fragment of its label), "auto" to let the strategy decide, or "clear" to fall back to the config. Applies to the next request without re-authenticating, so nothing in flight is cancelled.',
    args: {
      target: z
        .string()
        .describe(
          'preset name, account name or label fragment, "auto", or "clear"',
        ),
    },
    async execute({ target }) {
      const cfg = getConfig()
      const choice = target.trim()

      if (choice === "clear") {
        saveAccountSource("")
        maybeRotate("tool-clear", { force: true })
        return `Selection cleared — the config decides. Now on ${getActiveAccount()?.label ?? "none"}.`
      }

      if (choice === "auto") {
        saveAccountSource(AUTO_SOURCE)
        maybeRotate("tool-auto", { force: true })
        return `Auto (${cfg.strategy}). Now on ${getActiveAccount()?.label ?? "none"}.`
      }

      if (cfg.presets[choice]) {
        saveAccountSource(`${PRESET_PREFIX}${choice}`)
        maybeRotate("tool-preset", { force: true })
        const p = cfg.presets[choice]!
        return `Preset "${p.label ?? choice}" (${p.strategy ?? cfg.strategy}). Now on ${getActiveAccount()?.label ?? "none"}.`
      }

      const source = resolveRef(choice, members())
      if (!source) {
        const known = Object.keys(cfg.presets).join(", ") || "(none)"
        return `No preset or account matches "${choice}". Presets: ${known}. Accounts: ${members()
          .map((m) => m.label ?? m.source)
          .join(", ")}`
      }

      saveAccountSource(source)
      maybeRotate("tool-pin", { force: true })
      return `Pinned to ${members().find((m) => m.source === source)?.label ?? source}.`
    },
  }),

  claude_auth_reserve: tool({
    description:
      "Turn this session's reserved-quota override on or off. When on, this session may draw on accounts that are past their configured usage ceiling (their reserved quota) once no free account is left — including in hard cap mode. Affects only this session, and is forgotten after an hour idle. Spending reserved quota may consume a teammate's share, so every change is logged. Turning it on is refused unless the operator set agentReserve: true.",
    args: {
      state: z
        .enum(["on", "off"])
        .describe(
          '"on" to allow spending reserved quota this session, "off" to stop',
        ),
    },
    async execute({ state }, ctx) {
      const sessionId = ctx?.sessionID
      if (!sessionId) {
        return "No session in context, so the reserved-quota override cannot be set."
      }
      const refused = reserveRefusal(state, getConfig().agentReserve)
      if (refused) {
        log("reserve_override_refused", { session: sessionId, state })
        return refused
      }
      if (state === "on") allowReserve(sessionId)
      else revokeReserve(sessionId)
      log("reserve_override", { session: sessionId, state })
      return state === "on"
        ? "Reserved quota enabled for this session. It will spend accounts past their ceiling once nothing free is left."
        : "Reserved quota disabled for this session."
    },
  }),

  claude_auth_usage: tool({
    description:
      "Report per-account Claude usage over a window: requests served, share, refusals, errors, average latency, and how often the balancer rotated. Read-only.",
    args: {
      window: z
        .string()
        .optional()
        .describe('time window such as "1h", "24h", "7d" (default 24h)'),
    },
    async execute({ window }) {
      const spec = window && /^\d+[smhd]$/.test(window) ? window : "24h"
      const since = Date.now() - parseWindowMs(window)
      const summary = summarize(readUsage(since), since)

      if (summary.accounts.length === 0) {
        return `No Claude requests recorded in the last ${spec}.`
      }

      const total = summary.accounts.reduce((n, a) => n + a.requests, 0)
      const lines = [`Per-account usage, last ${spec} (${total} requests)`, ""]
      for (const a of summary.accounts) {
        lines.push(
          `  ${a.account.slice(-30).padEnd(30)} ${String(a.requests).padStart(5)} ${`${Math.round((a.requests / total) * 100)}%`.padStart(5)}  429:${a.refusals} err:${a.errors} avg:${a.avg_duration_ms}ms`,
        )
      }
      lines.push("", `rotations: ${summary.rotations}`)
      for (const [trigger, n] of Object.entries(summary.by_trigger)) {
        lines.push(`  ${trigger}: ${n}`)
      }

      return lines.join("\n")
    },
  }),
}
