import { describeRequest, recordShape } from "./introspect.ts"
import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import {
  applyAccountLabelToConfig,
  buildAdvisory,
  getAccountLabelPlacement,
  noticeKey,
  noticeToToast,
} from "./ui/index.ts"
import {
  formatQuotaPrefix,
  maybeRotate,
  noteRejection,
  spentRetryNow,
  noteSuccess,
  parseQuotaHeaders,
  quotaForAccount,
  readQuotaCache,
  SESSION_HEADER,
  assess,
  credentialState,
  describeSelection,
  pickStartupAccount,
  recordRequest,
  resolveSessionCredentials,
  boundSource,
  probeTargets,
  refreshQuotas,
  fetchIdentities,
  writeQuotaForAccount,
  accountKey,
  teeUsage,
  parseNonStreamUsage,
  SampleAggregator,
  appendSample,
  samplesPath,
  resolveTtl,
  type ResolvedTtl,
  type UsageTokens,
  resolveContextEditing,
  contextEditDisabledBy400,
  clearedInputTokens,
} from "./balance/index.ts"
import crypto from "node:crypto"
import { config } from "./model-config.ts"
import { readAllClaudeAccounts, type ClaudeAccount } from "./keychain.ts"
import { initLogger, log } from "./logger.ts"
import { COMMIT, VERSION } from "./version.ts"
import { emitNotice, setNoticeSink } from "./notify.ts"
import { getConfig, primeConfig } from "./config.ts"
import {
  addExcludedBeta,
  getExcludedBetas,
  getModelBetas,
  getNextBetaToExclude,
  isLongContextError,
  LONG_CONTEXT_BETAS,
} from "./betas.ts"
import { SYSTEM_IDENTITY, transformResponseStream } from "./transforms.ts"
import { prepareBody } from "./request-body.ts"
import {
  AUTO_SOURCE,
  PRESET_PREFIX,
  getActiveAccount,
  getCachedCredentials,
  reloadCredentialsFromSource,
  syncAuthJson,
  initAccounts,
  setActiveAccountSource,
  loadPersistedAccountSource,
  saveAccountSource,
  refreshAccountsList,
  refreshIfNeeded,
  type ClaudeCredentials,
} from "./credentials.ts"

export {
  addExcludedBeta,
  getExcludedBetas,
  getModelBetas,
  getNextBetaToExclude,
  isLongContextError,
  LONG_CONTEXT_BETAS,
} from "./betas.ts"
export { resetExcludedBetas } from "./betas.ts"
import { isPrefillError, stripTrailingAssistant } from "./prefill.ts"
export {
  stripToolPrefix,
  SYSTEM_IDENTITY,
  transformBody,
  transformResponseStream,
} from "./transforms.ts"
export {
  getCachedCredentials,
  syncAuthJson,
  refreshAccountsList,
  setActiveAccountSource,
  type ClaudeCredentials,
} from "./credentials.ts"
export {
  applyAccountLabelToConfig,
  decorateName,
  getAccountLabelPlacement,
  type AccountLabelPlacement,
} from "./ui/index.ts"
export {
  buildBillingHeaderValue,
  computeCch,
  computeVersionSuffix,
  extractFirstUserMessageText,
} from "./signing.ts"

/**
 * Whether this reading says the included allowance has just run out.
 *
 * Either window at or past its limit means anything further is billed to
 * credits -- exactly when the cached balance is out of date, because no
 * rate-limit header carries one.
 */
function isSpilling(q: {
  fiveHour?: { utilization?: number }
  sevenDay?: { utilization?: number }
}): boolean {
  return (
    (q.fiveHour?.utilization ?? 0) >= 1 || (q.sevenDay?.utilization ?? 0) >= 1
  )
}

function getCliVersion(): string {
  return process.env.ANTHROPIC_CLI_VERSION ?? config.ccVersion
}

function getUserAgent(): string {
  return (
    process.env.ANTHROPIC_USER_AGENT ??
    `claude-cli/${getCliVersion()} (external, sdk-cli)`
  )
}

function getStainlessHeaders(): Record<string, string> {
  return {
    "x-stainless-arch": process.arch === "arm64" ? "arm64" : process.arch,
    "x-stainless-lang": "js",
    "x-stainless-os":
      process.platform === "darwin" ? "MacOS" : process.platform,
    "x-stainless-package-version": "0.81.0",
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
    "x-stainless-timeout": "600",
  }
}

function buildRequestUrl(input: RequestInfo | URL): string | URL {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url

  const url = new URL(raw)
  if (url.pathname === "/v1/messages" && !url.searchParams.has("beta")) {
    url.searchParams.set("beta", "true")
  }

  return typeof input === "string" ? url.toString() : url
}

// Stable per-process session ID, matching Claude Code's X-Claude-Code-Session-Id
const sessionId = crypto.randomUUID()

// Long-memory usage samples: one row per account per 5-minute bucket, flushed
// to claude-auth/samples.jsonl when a bucket closes. Held here so every request
// in the process feeds the same aggregator. Flushed on a timer and at exit so a
// short-lived process still records its final, open bucket.
const sampleAggregator = new SampleAggregator(appendSample, samplesPath)
const SAMPLE_FLUSH_MS = 60_000

// Per-session request timing, for the "auto" cache TTL: when a session was
// first seen and when it last sent a request. Per-process and unbounded is
// fine -- a session key is small and the map is swept nowhere because these
// windows are minutes, not a leak worth a sweep.
const sessionTiming = new Map<string, { startedAt: number; lastAt: number }>()
{
  const timer = setInterval(() => sampleAggregator.flush(), SAMPLE_FLUSH_MS)
  // Don't keep the process alive for telemetry.
  if (typeof timer.unref === "function") timer.unref()
  const flushOnce = () => sampleAggregator.flush()
  process.once("exit", flushOnce)
  process.once("beforeExit", flushOnce)
}

type FetchFn = typeof fetch

// Maximum delay before we give up retrying and surface the error.
// A retry-after longer than this signals a quota/usage-limit reset (hours away)
// rather than a transient rate limit — retrying would hang indefinitely.
// Override with OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS for longer retry windows.
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000

function getMaxRetryDelayMs(): number {
  const env = process.env.OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS
  if (env) {
    const parsed = parseInt(env, 10)
    if (!Number.isNaN(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_MAX_RETRY_DELAY_MS
}

/**
 * The same 429, rewritten so OpenCode waits and retries instead of failing.
 *
 * OpenCode (2.2.x) retries a refused request only when it is classified as a
 * rate limit or carries `x-should-retry: true`; one whose text reads as quota
 * exhaustion ("usage limit", "quota exceeded", ...) is final. So the body is
 * a plain `rate_limit_error` with our message and nothing of the server's
 * wording, and the header asks for the retry explicitly. The server's own
 * message is returned for the log instead.
 */
export async function withSpentRetry(
  res: Response,
  plan: { retryAfterS: number; message: string },
): Promise<{ response: Response; upstream?: string }> {
  const text = await res.text().catch(() => "")
  let upstream: string | undefined
  try {
    const m = (JSON.parse(text) as { error?: { message?: unknown } })?.error
      ?.message
    if (typeof m === "string") upstream = m
  } catch {}
  const body = JSON.stringify({
    type: "error",
    error: { type: "rate_limit_error", message: plan.message },
  })
  const headers = new Headers(res.headers)
  headers.set("retry-after", String(plan.retryAfterS))
  headers.set("x-should-retry", "true")
  headers.set("content-type", "application/json")
  headers.delete("retry-after-ms")
  headers.delete("content-length")
  headers.delete("content-encoding")
  return {
    response: new Response(body, {
      status: 429,
      statusText: res.statusText,
      headers,
    }),
    ...(upstream !== undefined ? { upstream } : {}),
  }
}

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  retries = 3,
  fetchImpl: FetchFn = fetch,
): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const res = await fetchImpl(input, init)
    if ((res.status === 429 || res.status === 529) && i < retries - 1) {
      const retryAfter = res.headers.get("retry-after")
      const parsed = retryAfter ? parseInt(retryAfter, 10) : NaN
      const delay = Number.isNaN(parsed) ? (i + 1) * 2000 : parsed * 1000
      // If delay exceeds the cap, the server is signalling a quota/usage-limit
      // reset far in the future. Return immediately so the error surfaces to
      // the user rather than silently hanging until the reset time.
      if (delay > getMaxRetryDelayMs()) {
        log("fetch_rate_limited_quota", {
          status: res.status,
          retryAfter: retryAfter ?? "none",
          delayMs: delay,
        })
        return res
      }
      log("fetch_rate_limited", {
        status: res.status,
        attempt: i + 1,
        retryAfter: retryAfter ?? "none",
        delayMs: delay,
      })
      await new Promise((r) => setTimeout(r, delay))
      continue
    }
    return res
  }
  return fetchImpl(input, init)
}

// Server-side context editing is disabled for the rest of the process once the
// API rejects it, so a run on a model or account that lacks the beta recovers
// by retrying without it rather than failing every turn. Reset on restart.
let contextEditingDisabled = false

export function buildRequestHeaders(
  input: RequestInfo | URL,
  init: RequestInit,
  accessToken: string,
  modelId = "unknown",
  excludedBetas?: Set<string>,
): Headers {
  const headers = new Headers()

  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      headers.set(key, value)
    })
  }

  if (init.headers instanceof Headers) {
    init.headers.forEach((value, key) => {
      headers.set(key, value)
    })
  } else if (Array.isArray(init.headers)) {
    for (const [key, value] of init.headers) {
      if (typeof value !== "undefined") {
        headers.set(key, String(value))
      }
    }
  } else if (init.headers) {
    for (const [key, value] of Object.entries(init.headers)) {
      if (typeof value !== "undefined") {
        headers.set(key, String(value))
      }
    }
  }

  // Internal routing marker: it exists only to carry the session id from
  // chat.headers to the fetch above, and every header here is forwarded, so it
  // is removed centrally rather than at each call site.
  headers.delete(SESSION_HEADER)

  const modelBetas = getModelBetas(modelId, excludedBetas)
  const incomingBeta = headers.get("anthropic-beta") ?? ""
  const mergedBetas = [
    ...new Set([
      ...modelBetas,
      ...incomingBeta
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ]),
  ]

  headers.set("authorization", `Bearer ${accessToken}`)
  headers.set("anthropic-version", "2023-06-01")
  headers.set("anthropic-beta", mergedBetas.join(","))
  headers.set("anthropic-dangerous-direct-browser-access", "true")
  headers.set("x-app", "cli")
  headers.set("user-agent", getUserAgent())
  headers.set("x-client-request-id", crypto.randomUUID())
  headers.set("X-Claude-Code-Session-Id", sessionId)
  for (const [key, value] of Object.entries(getStainlessHeaders())) {
    if (!headers.has(key)) headers.set(key, value)
  }
  headers.delete("x-api-key")
  // The body is rewritten after this (context editing, cache TTL), so a
  // forwarded length or encoding would describe a different body.
  headers.delete("content-length")
  headers.delete("content-encoding")

  return headers
}

/**
 * Top up quota readings for every account.
 *
 * Detached and self-skipping: refreshQuotas ignores any account whose
 * reading is younger than quotaProbeMaxAge, so calling this often is cheap.
 * An exhausted account answers 429 and costs nothing; a healthy one spends a
 * single token.
 */
export function topUpQuota(trigger: string): void {
  const cfg = getConfig()
  if (!cfg.quotaProbe) return
  const all = refreshAccountsList()
  const targets = probeTargets(all, (a) => refreshIfNeeded(a))
  const live = new Set(targets.map((t) => t.source))
  const accounts = all.filter((a) => live.has(a.source))
  if (targets.length === 0) return

  // Resolve identity on the same fresh-token moment: an account not yet in the
  // identity cache is fetched once, detached, never on the request path. A 401
  // keeps whatever is cached.
  void fetchIdentities(
    accounts.map((a) => {
      const t: {
        source: string
        accessToken: string
        configDir?: string
      } = { source: a.source, accessToken: a.credentials.accessToken }
      if (a.configDir) t.configDir = a.configDir
      return t
    }),
  )
    .then((r) => {
      if (r.fetched > 0) log("identity_resolved", { trigger, ...r })
    })
    .catch(() => {})

  void refreshQuotas(targets, {
    maxAgeSeconds: Math.floor(cfg.quotaProbeMaxAge / 1000),
  })
    .then((r) => {
      if (r.probed > 0) log("quota_refreshed", { trigger, ...r })
    })
    .catch(() => {})
}

// The installed @opencode-ai/plugin types declare a single parameter, but the
// runtime passes inline options from opencode.jsonc as a second argument -- the
// mechanism other plugins already rely on. Typed explicitly rather than left
// implicitly `any`.
/**
 * The runtime passes inline options from opencode.jsonc as a second argument --
 * the mechanism other plugins already use -- but the installed
 * @opencode-ai/plugin types declare only one. Widening the signature here keeps
 * the hooks contextually typed, where a blanket cast would make every hook
 * parameter implicitly `any`.
 */
type PluginWithOptions = (
  input: PluginInput,
  options?: unknown,
) => ReturnType<Plugin>

const plugin: PluginWithOptions = async (
  { client, directory, worktree },
  options,
) => {
  // Inline options from opencode.jsonc are only visible here, so record them
  // once; file layers are re-read on change afterwards.
  const initialConfig = primeConfig(worktree || directory, options)
  initLogger({ config: initialConfig })

  let accounts: ClaudeAccount[] = []
  try {
    accounts = readAllClaudeAccounts()
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log("plugin_init_error", { error })
    console.warn(
      "opencode-claude-auth: Failed to read Claude Code credentials:",
      error,
    )
    return {}
  }

  initAccounts(accounts)

  const defaultAccountSource = accounts[0]?.source ?? null

  /**
   * Prefix a switcher row with that account's quota, e.g.
   * "[100% 1h19m] Claude Team - Team A".
   *
   * Quota is only known for accounts that have served a request on this machine,
   * since it is read from response headers. Unknown accounts are returned
   * unchanged rather than padded with a placeholder.
   */
  function prefixWithQuota(
    label: string,
    source: string,
    cache: ReturnType<typeof readQuotaCache>,
  ): string {
    try {
      const prefix = formatQuotaPrefix(quotaForAccount(source, cache))
      return prefix ? `${prefix} ${label}` : label
    } catch {
      return label
    }
  }

  /**
   * Label of the account currently serving requests, or "" if unknown.
   *
   * Reads the account list fresh: the user can switch accounts, or edit the
   * Keychain comment, without restarting OpenCode.
   */
  function activeAccountLabel(): string {
    try {
      // With balancing on there is no single account to name. The label is
      // written once, in the config hook, and cannot be rewritten mid-session —
      // so naming one account is a snapshot that goes stale on the first
      // rotation, and with per-session binding it is wrong for every session but
      // one. Name the arrangement instead: that stays true for as long as it is
      // selected, which is exactly what a fixed string can honestly claim.
      const cfg = getConfig()
      const persisted = loadPersistedAccountSource()
      const active = getActiveAccount()
      if (
        persisted === AUTO_SOURCE ||
        persisted?.startsWith(PRESET_PREFIX) ||
        (!persisted && cfg.preset)
      ) {
        // Same wording as the toast, from one function, so the two cannot drift.
        return describeSelection(cfg, persisted)
      }
      if (active) return active.label ?? ""

      const current = refreshAccountsList()
      const source = loadPersistedAccountSource() ?? defaultAccountSource
      const fallback =
        (source ? current.find((a) => a.source === source) : undefined) ??
        current.find((a) => credentialState(a) !== "unusable") ??
        current[0]
      return fallback?.label ?? ""
    } catch {
      // A display nicety must never break auth.
      return ""
    }
  }

  if (accounts.length > 0) {
    const persistedSource = loadPersistedAccountSource()
    // Auto, a chosen preset, or a preset named in the config all mean "the
    // strategy owns the choice" — so honour it at start-up rather than sitting
    // on whichever account the Keychain happened to list first.
    const managedSelection =
      persistedSource === AUTO_SOURCE ||
      persistedSource?.startsWith(PRESET_PREFIX) === true ||
      getConfig().preset !== ""
    const autoMode = persistedSource === AUTO_SOURCE
    // Never start on an account that cannot serve a request. accounts[0] is
    // whatever the Keychain listed first, and here that is an entry holding no
    // access token at all — starting there meant every init flipped the active
    // account back to it, the label advertised it, and any request landing
    // before the startup rotation had no credentials. That is the blank screen:
    // observed as a switch back to the dead entry immediately after a successful
    // rotation, once per plugin init, and the plugin inits more than once.
    const usable = accounts.filter((a) => credentialState(a) !== "unusable")
    const defaultAccount =
      pickStartupAccount(
        accounts,
        persistedSource,
        (a) => credentialState(a) !== "unusable",
      ) ?? accounts[0]

    setActiveAccountSource(defaultAccount.source)

    log("plugin_init", {
      version: VERSION,
      commit: COMMIT,
      // Who started this process. A plugin instance per opencode process is
      // correct, so a high init count is a question about the spawner, not the
      // plugin -- and answering it from the log beats guessing at `ps`, which
      // cannot see a process that already exited.
      pid: process.pid,
      ppid: process.ppid,
      argv: process.argv.slice(1).join(" ").slice(0, 200),
      accountCount: accounts.length,
      sources: accounts.map((a) => a.source),
      activeSource: defaultAccount.source,
      autoMode,
      managedSelection,
      usableAccounts: usable.length,
      skippedUnusable: accounts.length - usable.length,
    })

    // Start-up's job is a *valid* account, not a balancing decision. It used to
    // force a rotation on every init, which with a rotating strategy advanced
    // the cursor each time: three inits in thirteen seconds left the active
    // account oscillating between two accounts while OpenCode was constructing
    // the provider. Balancing still happens where it belongs — per session, and
    // whenever a response reports quota — so this only steps in when the account
    // chosen above cannot actually serve.
    const startupHealth = assess(
      [
        {
          source: defaultAccount.source,
          label: defaultAccount.label,
          credential: credentialState(defaultAccount),
        },
      ],
      readQuotaCache(),
      getConfig(),
    )[0]
    if (managedSelection && startupHealth && !startupHealth.healthy) {
      log("startup_rotating_off_unusable", {
        source: defaultAccount.source,
        reason: startupHealth.reason,
      })
      maybeRotate("startup", { force: true })
    }

    const initialCreds = getCachedCredentials()
    if (initialCreds) {
      syncAuthJson(initialCreds)
    } else {
      console.warn(
        "opencode-claude-auth: Claude credentials are expired and could not be refreshed. Run `claude` to re-authenticate.",
      )
    }

    // Surface credential events that change which account serves requests.
    // A refresh failing, or the plugin quietly falling back to a different
    // account, both happen without any user action and were previously visible
    // only in a log file nobody had enabled.
    const shownNotices = new Map<string, number>()
    setNoticeSink((notice) => {
      try {
        const advisory = noticeToToast(notice, {
          showSuccess: getConfig().toastOnRefresh,
        })
        if (!advisory) return

        // The same condition repeats every sync tick while it persists; say it
        // once, then stay quiet for a while.
        const key = noticeKey(notice)
        const last = shownNotices.get(key) ?? 0
        if (Date.now() - last < getConfig().noticeCooldown) return
        shownNotices.set(key, Date.now())

        void client.tui
          .showToast({
            body: {
              title: advisory.title,
              message: advisory.message,
              variant: advisory.variant,
              duration: advisory.variant === "error" ? 15_000 : 10_000,
            },
          })
          .catch(() => {})
        log("credential_notice_shown", {
          kind: notice.kind,
          variant: advisory.variant,
        })
      } catch (err) {
        log("credential_notice_failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    // Give every switcher row a figure. Passive capture only ever learns about
    // the account already serving traffic, which is the one the user already
    // knows, so filling the rest needs a probe.
    //
    // Opt-in, not opt-out: this spends a request per account with the user's own
    // tokens, and start-up is not an obvious place for unsolicited network
    // traffic -- upstream's tests stub fetch and count calls, and quite
    // reasonably did not expect init to make any. Passive capture keeps working
    // regardless; set CLAUDE_AUTH_QUOTA_PROBE=1 to fill every switcher row.
    if (getConfig().quotaProbe) {
      const probeTargets = accounts
        .map((a) => ({
          source: a.source,
          accessToken: a.credentials?.accessToken ?? "",
        }))
        .filter((a) => a.accessToken)

      void refreshQuotas(probeTargets)
        .then(async (r) => {
          log("quota_probe", r)

          // OpenCode's status bar cannot be extended -- there is no statusline
          // plugin hook or endpoint -- so an actionable state is delivered as a
          // toast. Silent unless something is worth interrupting for.
          try {
            // The thresholds are configurable, so pass them. Omitting this
            // argument left quotaWarnAt, quotaWeeklyWarnAt and
            // quotaAlternativeAt settable, validated and documented while
            // buildAdvisory silently used its own constants instead.
            const advisoryCfg = getConfig()
            const advisory = buildAdvisory(
              accounts.map((a) => ({ source: a.source, label: a.label })),
              readQuotaCache(),
              getActiveAccount()?.source ?? null,
              undefined,
              {
                warnAt: advisoryCfg.quotaWarnAt,
                weeklyWarnAt: advisoryCfg.quotaWeeklyWarnAt,
                alternativeAt: advisoryCfg.quotaAlternativeAt,
                maxAgeSeconds: Math.floor(advisoryCfg.quotaMaxAge / 1000),
              },
            )
            if (!advisory) return
            await client.tui.showToast({
              body: {
                title: advisory.title,
                message: advisory.message,
                variant: advisory.variant,
                duration: 12_000,
              },
            })
            log("quota_advisory_shown", {
              variant: advisory.variant,
              message: advisory.message,
            })
          } catch (err) {
            // A missing TUI (headless/serve) or any client error is not fatal.
            log("quota_advisory_failed", {
              error: err instanceof Error ? err.message : String(err),
            })
          }
        })
        .catch(() => {})
    }

    // Keep auth.json synced and proactively refresh before expiry.
    // refreshIfNeeded() always resolves the currently ACTIVE account
    // (via getActiveAccount() internally) — not a closure-captured account
    // list — so this stays correct across account switches. Passing
    // PROACTIVE_REFRESH_THRESHOLD_MS (1 hour) means it triggers a real
    // OAuth refresh once the token is within that window of expiry, and
    // simply returns the untouched credentials otherwise (no-op refresh).
    // This prevents the "run `claude` to re-authenticate" message from
    // appearing mid-session when the token silently expires.
    let proactiveRefreshWarned = false

    // Rescheduled after each tick rather than a fixed setInterval, so editing
    // refreshCheckInterval takes effect without a restart -- the same promise
    // the rest of the config makes. setInterval would capture the value once.
    let syncTimer: ReturnType<typeof setTimeout>
    const scheduleSync = () => {
      syncTimer = setTimeout(() => {
        runSyncTick()
        scheduleSync()
      }, getConfig().refreshCheckInterval)
      syncTimer.unref?.()
    }

    const runSyncTick = () => {
      // Quota ages the same way credentials do, and the account switcher cannot
      // fetch on open -- its prompts getter is synchronous and OpenCode rejects
      // a promise (verified: /provider/auth 500). Keeping the cache warm here is
      // what makes the switcher current when it is opened.
      topUpQuota("sync-tick")

      // Rotate on the timer too, not only after a response. Without this a
      // spent account is discovered by the NEXT request, which pays for the
      // discovery; on an idle session the move can happen before you type.
      maybeRotate("sync-tick")

      try {
        const account = getActiveAccount()
        log("proactive_refresh_check", {
          source: account?.source ?? null,
          expiresAt: account?.credentials?.expiresAt ?? null,
          thresholdMs: getConfig().refreshBeforeExpiry,
        })

        const creds = refreshIfNeeded(
          undefined,
          getConfig().refreshBeforeExpiry,
        )
        if (creds) {
          syncAuthJson(creds)
          if (proactiveRefreshWarned) {
            log("proactive_refresh_recovered", { source: account?.source })
          }
          proactiveRefreshWarned = false
        } else {
          log("proactive_refresh_failed", { source: account?.source })
          // Only warn once per outage — otherwise this fires every
          // every check interval for as long as refresh keeps failing.
          if (!proactiveRefreshWarned) {
            proactiveRefreshWarned = true
            console.warn(
              `opencode-claude-auth: Proactive token refresh failed for ${account?.label ?? account?.source ?? "the active account"}. Run \`claude\` to re-authenticate.`,
            )
          }
        }
      } catch {
        // Non-fatal
      }
    }

    scheduleSync()
  } else {
    log("plugin_init_no_accounts", { reason: "no credentials found" })
    console.warn(
      "opencode-claude-auth: No Claude Code credentials found. Running in API key mode with transform hook enabled.",
    )
  }

  // Loaded here rather than imported at module scope: tools.ts pulls in
  // @opencode-ai/plugin for its `tool()` helper, and having that in the static
  // graph made node:test cancel 28 subtests in index.test.ts. A dynamic import
  // runs once, at init, and a failure to load costs the tools rather than the
  // plugin.
  let registeredTools: Record<string, unknown> | undefined
  if (getConfig().tools) {
    try {
      registeredTools = (await import("./ui/tools.ts")).claudeAuthTools
      log("tools_registered", { names: Object.keys(registeredTools) })
    } catch (err) {
      log("tools_register_failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    ...(registeredTools ? { tool: registeredTools } : {}),

    // The only place a session id is available. Stamped as a header because the
    // custom fetch below cannot otherwise know which session a request belongs
    // to — the provider is registered once, for all of them.
    "chat.headers": async (input, output) => {
      const bind = getConfig().bindBy === "session"
      if (bind) {
        output.headers[SESSION_HEADER] = input.sessionID
      }
      log("chat_headers", {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model?.id ?? null,
        stamped: bind,
      })
    },

    config: async (opencodeConfig) => {
      // Show which account is serving this session. The switcher label is
      // otherwise visible only while the switcher is open, so with several
      // accounts configured nothing on screen tells them apart.
      try {
        const placement = getAccountLabelPlacement()
        const label = activeAccountLabel()
        const applied = applyAccountLabelToConfig(
          opencodeConfig,
          label,
          placement,
        )
        log("account_label_config", {
          label: label || "(none)",
          placement,
          provider: applied.provider,
          models: applied.models,
        })
      } catch (err) {
        // Never let a cosmetic label stop the config from loading.
        log("account_label_failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (input.model?.providerID !== "anthropic") {
        return
      }

      const hasIdentityPrefix = output.system.some((entry) =>
        entry.includes(SYSTEM_IDENTITY),
      )
      if (!hasIdentityPrefix) {
        output.system.unshift(SYSTEM_IDENTITY)
      }
    },
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        log("auth_loader_called", { authType: auth.type })
        if (auth.type !== "oauth") {
          log("auth_loader_skipped", {
            authType: auth.type,
            reason: "auth type is not oauth",
          })
          return {}
        }

        // Catalog pricing is kept: the subscription pays, but the API-equivalent
        // cost is what tells a heavy session from a light one.
        log("auth_loader_ready", {
          modelCount: Object.keys(provider.models).length,
        })

        return {
          apiKey: "",
          baseURL: "https://api.anthropic.com/v1",
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            // Which session is this? Per-session binding lets parallel
            // subagents — each its own session — run on different accounts
            // instead of queueing on one. Resolved per request against that
            // session's own account, never by mutating the global active one,
            // because concurrent requests would then race each other's token.
            // Named apart from the module-level `sessionId`, which is the
            // synthetic Claude-Code session id sent upstream. This one is
            // OpenCode's, and the two must never be confused.
            const ocSessionId = new Headers(
              (init?.headers ?? {}) as HeadersInit,
            ).get(SESSION_HEADER)
            let sessionCreds: ClaudeCredentials | null = null
            if (ocSessionId && getConfig().bindBy === "session") {
              try {
                sessionCreds = resolveSessionCredentials(ocSessionId)
              } catch (err) {
                log("session_bind_failed", {
                  sessionId: ocSessionId,
                  error: err instanceof Error ? err.message : String(err),
                })
              }
            }

            const latest = sessionCreds ?? getCachedCredentials()
            // The path this request takes, recorded on its usage row.
            const steps: string[] = [sessionCreds ? "bound" : "active"]

            // The account this request actually goes out on, captured here
            // rather than re-derived once the response is back.
            //
            // `maybeRotate("sync-tick")` moves the active account on a timer,
            // with no request involved, and a streaming completion outlives
            // several ticks. Asking `getActiveAccount()` on the way back
            // therefore credits the response to whoever happens to be active by
            // then -- which wrote one account's headers onto another's key,
            // until three separate subscriptions were all reporting the same
            // reset anchor and the balancer called them unanimously spent.
            let servingSource =
              (sessionCreds && ocSessionId
                ? (boundSource(ocSessionId) ?? null)
                : null) ??
              getActiveAccount()?.source ??
              null

            if (!latest) {
              log("fetch_no_credentials", { modelId: "unknown" })
              throw new Error(
                "Claude Code credentials are unavailable or expired. Run `claude` to refresh them.",
              )
            }

            const requestInit = init ?? {}
            const bodyStr =
              typeof requestInit.body === "string"
                ? requestInit.body
                : undefined
            // The one parse of the request body; every rewrite below reuses it.
            let parsedBody: unknown
            if (bodyStr) {
              try {
                parsedBody = JSON.parse(bodyStr)
              } catch {}
            }
            const modelId =
              (parsedBody as { model?: string } | undefined)?.model ?? "unknown"

            log("fetch_credentials", {
              modelId,
              accessToken: latest.accessToken,
              expiresAt: latest.expiresAt,
            })

            // Get excluded betas for this model (from previous failed requests)
            const excluded = getExcludedBetas(modelId)
            const requestUrl = buildRequestUrl(input)
            // Every request through this fetch, by endpoint. Its absence was a
            // real blind spot: a request to anything other than /v1/messages was
            // indistinguishable in the log from a chat turn, because the only
            // identifier recorded came from parsing a chat body.
            const requestPath = (() => {
              try {
                return new URL(requestUrl).pathname
              } catch {
                return String(requestUrl)
              }
            })()
            log("fetch_request", {
              path: requestPath,
              method: (init?.method ?? "POST").toUpperCase(),
            })
            const headers = buildRequestHeaders(
              input,
              requestInit,
              latest.accessToken,
              modelId,
              excluded,
            )
            // Relabel the request's cache_control markers to a longer TTL when
            // the session has paused long enough that the cheaper 5m write
            // would have gone cold before the next turn. Only touches markers
            // OpenCode already placed; "5m" and a body with none are no-ops.
            let ttl: ResolvedTtl | undefined
            if (bodyStr && ocSessionId) {
              const now = Date.now()
              const t = sessionTiming.get(ocSessionId)
              ttl = resolveTtl(getConfig().cacheTtl, {
                nowMs: now,
                ...(t
                  ? { prevRequestAt: t.lastAt, sessionStartedAt: t.startedAt }
                  : {}),
              })
              sessionTiming.set(ocSessionId, {
                startedAt: t?.startedAt ?? now,
                lastAt: now,
              })
            }
            const prepared = prepareBody(requestInit.body, parsedBody, {
              ...(ttl ? { ttl } : {}),
              // Only a Messages call takes context_management; count_tokens
              // and the rest would 400 on it and switch editing off for all.
              contextEditing:
                contextEditingDisabled || !requestPath.endsWith("/messages")
                  ? null
                  : resolveContextEditing(getConfig()),
            })
            let body = prepared.body
            let contextEdited = prepared.contextEdited
            let withoutEditing = prepared.withoutEditing
            if (contextEdited) {
              const s = resolveContextEditing(getConfig())
              log("context_edit_applied", {
                trigger: s?.trigger,
                keep: s?.keep,
                clearAtLeast: s?.clearAtLeast,
              })
            }
            // Only what the body actually carried: an unmarked body sent no 1h.
            const sentTtl: "5m" | "1h" =
              prepared.ttlSet && ttl === "1h" ? "1h" : "5m"
            if (sentTtl === "1h") steps.push("ttl-1h")
            if (contextEdited) steps.push("ctx-edit")

            // Record the shape of what actually goes out — system blocks, tool
            // schemas, message sizes. Off unless asked for: the body carries the
            // conversation. Taken from the TRANSFORMED body, because that is the
            // request Anthropic receives, not the one OpenCode handed us.
            const captureLevel = getConfig().captureRequests
            if (captureLevel !== "off") {
              const shape = describeRequest(
                prepared.sent ?? bodyStr,
                captureLevel,
                ocSessionId,
                typeof body === "string" ? Buffer.byteLength(body) : undefined,
              )
              if (shape) recordShape(shape)
            }

            const headerKeys: string[] = []
            headers.forEach((_, key) => {
              headerKeys.push(key)
            })
            const betas = (headers.get("anthropic-beta") ?? "")
              .split(",")
              .filter(Boolean)
            log("fetch_headers_built", { headerKeys, betas, modelId })

            const startedAt = Date.now()
            let response = await fetchWithRetry(requestUrl, {
              ...requestInit,
              body,
              headers,
            })

            log("fetch_response", {
              status: response.status,
              modelId,
              retryAttempt: 0,
            })

            // On 401, bypass the in-memory cache to pick up credentials rotated by
            // another client, then retry once only when the access token changed.
            let preserveResponseUnchanged = false
            if (response.status === 401) {
              steps.push("auth-401")
              let refreshed: ClaudeCredentials | null = null
              try {
                refreshed = reloadCredentialsFromSource()
              } catch {}

              // The source had nothing newer, yet the server rejected this
              // token: the stored credential is itself stale, and reloading it
              // again will never help. This is the shape of a session that sat
              // idle -- overnight, or awaiting a permission prompt -- while its
              // access token was rotated or revoked out from under it. A 401 is
              // proof enough to spend a refresh, which is safe now that
              // refreshing takes a per-account lock and re-reads first.
              if (!refreshed || refreshed.accessToken === latest.accessToken) {
                try {
                  log("stale_token_forcing_refresh", {
                    reason: "401 with no newer credentials at the source",
                    modelId,
                  })
                  // A threshold of Infinity means "treat it as expired now".
                  refreshed =
                    refreshIfNeeded(undefined, Number.POSITIVE_INFINITY) ?? null
                } catch (err) {
                  log("stale_token_refresh_failed", {
                    error: err instanceof Error ? err.message : String(err),
                  })
                }
              }

              if (refreshed && refreshed.accessToken !== latest.accessToken) {
                const retryHeaders = buildRequestHeaders(
                  input,
                  requestInit,
                  refreshed.accessToken,
                  modelId,
                  excluded,
                )
                response = await fetchWithRetry(requestUrl, {
                  ...requestInit,
                  body,
                  headers: retryHeaders,
                })
              } else {
                preserveResponseUnchanged = true
              }
            }

            // A model that refuses an assistant prefill fails the same way on
            // every retry, because the body is rebuilt identically each time.
            // Dropping the trailing assistant turn is the only thing that
            // changes the outcome -- and it is lossy, so it happens once, only
            // on this specific 400, and only when asked for.
            if (response.status === 400 && getConfig().retryPrefillError) {
              const cloned = response.clone()
              const errorBody = await cloned.text()
              if (isPrefillError(errorBody)) {
                // Loud on purpose. This rewrites the request before it is sent
                // again, so the conversation the model answered is not the one
                // the session composed -- that must never be inferable only
                // from a 400 that stopped appearing.
                log("prefill_detected", { level: "warn", modelId, status: 400 })
                const trimmed =
                  typeof body === "string" ? stripTrailingAssistant(body) : null
                if (trimmed) {
                  // A later retry (context editing off) must resend the
                  // trimmed conversation, not the one already refused.
                  body = trimmed.body
                  steps.push(`prefill-trim:${trimmed.dropped}`)
                  const untrimmed = withoutEditing
                  withoutEditing = () => {
                    const s = untrimmed()
                    return typeof s === "string"
                      ? (stripTrailingAssistant(s)?.body ?? s)
                      : s
                  }
                  const creds = getCachedCredentials()
                  const before = Date.now()
                  response = await fetchWithRetry(requestUrl, {
                    ...requestInit,
                    body: trimmed.body,
                    headers: buildRequestHeaders(
                      input,
                      requestInit,
                      creds?.accessToken ?? latest.accessToken,
                      modelId,
                      getExcludedBetas(modelId),
                    ),
                  })
                  const recovered = response.status < 400
                  log(
                    recovered ? "prefill_recovered" : "prefill_retry_failed",
                    {
                      level: recovered ? "warn" : "error",
                      modelId,
                      droppedAssistantTurns: trimmed.dropped,
                      status: response.status,
                      durationMs: Date.now() - before,
                    },
                  )
                  if (recovered) {
                    emitNotice({
                      kind: "prefill-recovered",
                      model: modelId,
                      dropped: trimmed.dropped,
                    })
                  }
                } else {
                  // Nothing safe to strip. Said out loud with the reason, so
                  // this does not read as the retry having silently done
                  // nothing.
                  log("prefill_retry_skipped", {
                    level: "error",
                    modelId,
                    reason:
                      typeof body === "string"
                        ? "no trailing assistant turn to drop, or dropping would empty the conversation"
                        : "request body was not a string",
                  })
                }
              }
            }

            // The server rejected context editing itself (unsupported beta, or
            // a model/account without it). Disable it for the process and retry
            // once with the un-edited body, mirroring the prefill recovery — the
            // retry body is the transformed one before the context_management
            // block was added, so nothing else about the request changes.
            if (response.status === 400 && contextEdited) {
              const errorBody = await response.clone().text()
              if (contextEditDisabledBy400(errorBody)) {
                contextEditingDisabled = true
                steps.push("ctx-off")
                contextEdited = false
                log("context_edit_disabled", { level: "warn", modelId })
                const creds = getCachedCredentials()
                response = await fetchWithRetry(requestUrl, {
                  ...requestInit,
                  body: withoutEditing(),
                  headers: buildRequestHeaders(
                    input,
                    requestInit,
                    creds?.accessToken ?? latest.accessToken,
                    modelId,
                    getExcludedBetas(modelId),
                  ),
                })
              }
            }

            // Check for long-context beta errors and retry with betas excluded
            // Try up to LONG_CONTEXT_BETAS.length times, excluding one more beta each time
            for (
              let attempt = 0;
              attempt < LONG_CONTEXT_BETAS.length;
              attempt++
            ) {
              if (response.status !== 400 && response.status !== 429) {
                break
              }

              const cloned = response.clone()
              const responseBody = await cloned.text()

              if (!isLongContextError(responseBody)) {
                break
              }

              const betaToExclude = getNextBetaToExclude(modelId)
              if (!betaToExclude) {
                break // All long-context betas already excluded
              }

              addExcludedBeta(modelId, betaToExclude)
              steps.push(`beta-off:${betaToExclude}`)
              log("fetch_beta_excluded", {
                modelId,
                excludedBeta: betaToExclude,
              })

              // Rebuild headers without the excluded beta and retry
              const currentCreds = getCachedCredentials()
              const retryToken = currentCreds?.accessToken ?? latest.accessToken
              const newExcluded = getExcludedBetas(modelId)
              const newHeaders = buildRequestHeaders(
                input,
                requestInit,
                retryToken,
                modelId,
                newExcluded,
              )

              response = await fetchWithRetry(requestUrl, {
                ...requestInit,
                body,
                headers: newHeaders,
              })
            }

            // A 429 that survived every retry above is a real exhaustion, not
            // congestion. Rotate off this account and give the request one more
            // chance on the next one, so a spent account costs a retry instead
            // of the turn. The rotation itself is hot: the token is resolved per
            // request, so nothing has to be re-registered for this to land.
            if (response.status === 429) {
              const refusedSource = servingSource
              const rotated = noteRejection(refusedSource, response.headers)
              const rotatedCreds = rotated ? getCachedCredentials() : null
              if (
                rotatedCreds &&
                rotatedCreds.accessToken !== latest.accessToken
              ) {
                servingSource = rotated?.source ?? servingSource
                steps.push(
                  `rotate:${accountKey(refusedSource ?? "?")}>${accountKey(servingSource ?? "?")}`,
                )
                log("fetch_retry_after_rotate", {
                  modelId,
                  from: refusedSource,
                  to: rotated?.source,
                  strategy: rotated?.strategy,
                })
                response = await fetchWithRetry(requestUrl, {
                  ...requestInit,
                  body,
                  headers: buildRequestHeaders(
                    input,
                    requestInit,
                    rotatedCreds.accessToken,
                    modelId,
                    getExcludedBetas(modelId),
                  ),
                })
                preserveResponseUnchanged = false
              }
            }

            // Still refused after rotating: the pool is spent, not congested.
            // Tell OpenCode when the next account is really back, and retry
            // within a minute so a reset or an added account is picked up.
            if (response.status === 429) {
              const raw = parseInt(
                response.headers.get("retry-after") ?? "",
                10,
              )
              const serverS = Number.isNaN(raw) ? undefined : raw
              if (
                serverS === undefined ||
                serverS * 1000 > getMaxRetryDelayMs()
              ) {
                steps.push("spent")
                const plan = spentRetryNow(serverS)
                const spent = await withSpentRetry(response, plan)
                response = spent.response
                log("spent_pool_retry", {
                  retryAfterS: plan.retryAfterS,
                  upstream: spent.upstream,
                })
                preserveResponseUnchanged = false
              }
            }

            // Record non-200 responses without writing over OpenCode's terminal UI.
            if (!response.ok) {
              const status = response.status
              const cloned = response.clone()
              cloned
                .text()
                .then((errorBody) => {
                  let message = errorBody
                  try {
                    const parsed = JSON.parse(errorBody) as {
                      error?: { type?: string; message?: string }
                    }
                    message =
                      parsed.error?.message ?? parsed.error?.type ?? errorBody
                  } catch {}
                  log("fetch_error_response", { status, modelId, message })
                })
                .catch(() => {})
            }

            // Every Anthropic response reports this account's utilisation and
            // reset time. Recording it here is free, and the account switcher
            // builds its rows synchronously so it cannot fetch them itself.
            let observedQuota: ReturnType<typeof parseQuotaHeaders>
            try {
              const quota = parseQuotaHeaders(response.headers)
              observedQuota = quota
              const source = servingSource
              // Crossing into paid territory is the one moment the money
              // figures matter and the one moment they are certainly stale:
              // headers carry no credit state, so the cached balance predates
              // the spend that just happened. Ask again.
              //
              // Unconditional on purpose -- topUpQuota already refuses when
              // the reading is fresh and complete (a ten-minute debounce) and
              // when the endpoint has rate-limited us. Adding a third guard
              // here would just be a slower way of reaching the same answer.
              if (quota && isSpilling(quota)) topUpQuota("spilling")
              if (quota && source) {
                writeQuotaForAccount(source, quota)
                log("quota_observed", {
                  source,
                  fiveHour: quota.fiveHour?.utilization,
                  sevenDay: quota.sevenDay?.utilization,
                  status: quota.fiveHour?.status,
                })
              }
            } catch {
              // Never let bookkeeping break a response.
            }

            // Usage history, which the quota cache cannot provide: it holds only
            // the latest reading per account, so it answers "how full is this
            // account" but never "how much has it served, and how often was it
            // refused". Recorded for every response, refusals included.
            //
            // The token counts live in the response body, not the headers, and a
            // streamed response delivers the output count only at the end — so
            // this closure is called with whatever usage is known: immediately
            // for a non-streamed response, or once the tee below has drained for
            // a chat stream. The same call feeds the long-memory sample buckets.
            const servedBy = servingSource
            const u5 = observedQuota?.fiveHour?.utilization
            const u7 = observedQuota?.sevenDay?.utilization
            let recorded = false
            const recordRow = (usage: UsageTokens | null): void => {
              if (!servedBy || recorded) return
              recorded = true
              const account = accountKey(servedBy)
              recordRequest({
                account,
                model: modelId,
                ...(ocSessionId ? { session: ocSessionId } : {}),
                status: response.status,
                duration_ms: Date.now() - startedAt,
                ...(u5 !== undefined ? { utilization_5h: u5 } : {}),
                ...(u7 !== undefined ? { utilization_7d: u7 } : {}),
                ttl: sentTtl,
                ...(contextEdited ? { contextEdited: true } : {}),
                steps: [...steps, `status:${response.status}`],
                ...(usage
                  ? {
                      input: usage.input,
                      output: usage.output,
                      cacheRead: usage.cacheRead,
                      cacheWrite: usage.cacheWrite,
                      cacheWrite1h: usage.cacheWrite1h,
                    }
                  : {}),
              })
              try {
                sampleAggregator.observe({
                  at: Date.now(),
                  account,
                  ...(u5 !== undefined ? { u5 } : {}),
                  ...(u7 !== undefined ? { u7 } : {}),
                  ...(usage
                    ? {
                        input: usage.input,
                        output: usage.output,
                        cacheRead: usage.cacheRead,
                        cacheWrite: usage.cacheWrite + usage.cacheWrite1h,
                      }
                    : {}),
                })
              } catch {
                // Telemetry must never break a response.
              }
            }

            // Act on the reading just recorded. Every response is a free
            // measurement of the active account, so this is where exhaustion is
            // noticed *before* the next request is refused — the 429 path above
            // is the safety net, not the main mechanism.
            if (response.ok) {
              noteSuccess(servedBy)
              maybeRotate("quota-observed")
            }

            // transformResponseStream rewrites a server-sent-event chat stream.
            // Anything else — a model list, a token endpoint, a count call — is
            // JSON, and feeding it through an SSE transform can only corrupt it.
            // It was applied to every response regardless of endpoint, which is
            // a latent fault whether or not it explains a given symptom.
            const isChatStream = requestPath.endsWith("/messages")
            if (!isChatStream) {
              log("fetch_untransformed", { path: requestPath })
            }

            // A chat response — streamed SSE or a streamed error — carries the
            // token usage we want. Tee it: the client gets every byte unchanged
            // while a copy is parsed for usage, and recordRow fires once the
            // stream ends. Applied to whichever body we return (the transformed
            // stream, or the raw one when a retry asked us to preserve it).
            if (isChatStream) {
              const out =
                preserveResponseUnchanged || !response.ok
                  ? response
                  : transformResponseStream(response)
              return teeUsage(out, recordRow)
            }

            // A non-chat endpoint answers with a single JSON object. Read usage
            // off a clone so the body the caller receives is untouched, then
            // record. The clone is drained in the background; recordRow is
            // idempotent, so a slow or failed read still leaves exactly one row.
            response
              .clone()
              .text()
              .then((text) => {
                recordRow(parseNonStreamUsage(text))
                // Server-reported context editing: how many input tokens it
                // cleared this turn, when the response echoes applied_edits.
                // Only on the non-streamed path; a streamed chat delivers it
                // inside the SSE events, which the usage tee does not surface.
                if (contextEdited) {
                  try {
                    const cleared = clearedInputTokens(JSON.parse(text))
                    if (cleared !== null) {
                      log("context_edit_cleared", { modelId, cleared })
                    }
                  } catch {}
                }
              })
              .catch(() => recordRow(null))
            return response
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Switch Claude Code account",

          get prompts() {
            const currentAccounts = refreshAccountsList()
            const currentSource =
              loadPersistedAccountSource() ?? defaultAccountSource
            // Count what can actually serve. Five entries of which four are
            // logged out is not a choice worth presenting.
            if (
              currentAccounts.filter((a) => credentialState(a) !== "unusable")
                .length <= 1
            ) {
              return []
            }
            // Read once per open, not once per row.
            const quotaCache = readQuotaCache()
            // Values shown come from the cache; this refreshes it for the next
            // open. The getter cannot await, so it cannot show its own result.
            topUpQuota("switcher-open")

            // An account holding no usable credentials is not a choice — it is
            // an entry for a config directory nobody logs into. Offering it
            // invites selecting an account that cannot answer, which is exactly
            // how the default ~/.claude entry ended up looking like the active
            // account. Kept if nothing else is usable, because an empty
            // switcher would be worse than a hopeless one.
            const usableAccounts = currentAccounts.filter(
              (a) => credentialState(a) !== "unusable",
            )
            const selectableAccounts =
              usableAccounts.length > 0 ? usableAccounts : currentAccounts
            if (usableAccounts.length !== currentAccounts.length) {
              log("switcher_hid_unusable", {
                hidden: currentAccounts
                  .filter((a) => credentialState(a) === "unusable")
                  .map((a) => a.source),
              })
            }

            const cfgNow = getConfig()

            // Presets and Auto are offered here again. Every choice in this
            // switcher ends in authorize(), after which OpenCode disposes the
            // instance — but that is true of picking a plain account too, so
            // withholding the load-balancing rows removed the only discoverable
            // way to reach them without buying any safety. `pnpm lb <preset>`
            // and claude_auth_select remain the non-disruptive route, and the
            // prompt says so.
            const presetRows = Object.entries(cfgNow.presets).map(
              ([name, preset]) => {
                const value = `${PRESET_PREFIX}${name}`
                const count = preset.pools
                  ? preset.pools.reduce((n, p) => n + p.accounts.length, 0)
                  : (preset.accounts?.length ?? 0)
                const row: { label: string; value: string; hint?: string } = {
                  label: `LB · ${(preset.label ?? name).replace(/^LB\s+/i, "")} — ${preset.strategy ?? cfgNow.strategy} over ${count}`,
                  value,
                }
                if (currentSource === value) row.hint = "active"
                return row
              },
            )

            const autoRow: { label: string; value: string; hint?: string } = {
              label: `LB · Auto — balance across all accounts (${cfgNow.strategy})`,
              value: AUTO_SOURCE,
            }
            if (currentSource === AUTO_SOURCE) autoRow.hint = "active"

            return [
              {
                type: "select" as const,
                key: "account",
                message:
                  "Select a Claude Code account (restarts the session — use `pnpm lb` or claude_auth_select to switch without one):",
                // `hint` must be a string when present. Passing undefined fails
                // OpenCode's schema validation for the whole request --
                // /provider/auth answers 500, the TUI falls back to its built-in
                // "API key" prompt, and every account becomes unreachable. Omit
                // the key instead of setting it to undefined.
                options: [
                  ...presetRows,
                  autoRow,
                  ...selectableAccounts.map((a) => {
                    const option: {
                      label: string
                      value: string
                      hint?: string
                    } = {
                      label: prefixWithQuota(a.label, a.source, quotaCache),
                      value: a.source,
                    }
                    if (a.source === currentSource) option.hint = "active"
                    return option
                  }),
                ],
              },
            ]
          },

          async authorize(inputs) {
            const latestAccounts = refreshAccountsList()
            log("authorize_called", {
              requested: inputs?.account ?? null,
              accountCount: latestAccounts.length,
            })

            // A preset and Auto differ only in which accounts are eligible, so
            // they share one path: persist the choice, let the strategy pick now.
            const chosenPreset = inputs?.account?.startsWith(PRESET_PREFIX)
              ? inputs.account.slice(PRESET_PREFIX.length)
              : null

            if (inputs?.account === AUTO_SOURCE || chosenPreset) {
              saveAccountSource(inputs!.account!)
              if (!getActiveAccount() && latestAccounts[0]) {
                setActiveAccountSource(latestAccounts[0].source)
              }
              // Deliberately NOT rotating here. Rotating mid-authorize changed
              // the account between the request and the response, so the tokens
              // handed back were a different account's than the flow began with,
              // and it put a second writer on auth.json in the same millisecond
              // OpenCode was reading it. The selection is persisted above; the
              // strategy applies on the next request, per session, as designed.

              const active =
                getActiveAccount() ?? latestAccounts[0] ?? accounts[0]
              const creds = getCachedCredentials() ?? active.credentials
              syncAuthJson(creds)

              const cfgNow = getConfig()
              const what = chosenPreset
                ? `Preset "${cfgNow.presets[chosenPreset]?.label ?? chosenPreset}"`
                : `Balancing across ${latestAccounts.length} accounts`
              const how = chosenPreset
                ? (cfgNow.presets[chosenPreset]?.strategy ?? cfgNow.strategy)
                : cfgNow.strategy

              log("authorize_returning", {
                mode: chosenPreset ? "preset" : "auto",
                preset: chosenPreset,
                active: active.source,
                hasAccess: !!creds.accessToken,
                expiresAt: creds.expiresAt ?? null,
              })

              return {
                url: "",
                instructions: `${what} (${how}) — currently ${active.label}.`,
                method: "auto",
                async callback() {
                  return {
                    type: "success",
                    provider: "anthropic",
                    access: creds.accessToken,
                    refresh: creds.refreshToken,
                    expires: creds.expiresAt,
                  }
                },
              }
            }

            const source =
              inputs?.account ?? latestAccounts[0]?.source ?? accounts[0].source
            const chosen =
              latestAccounts.find((a) => a.source === source) ??
              accounts.find((a) => a.source === source) ??
              latestAccounts[0] ??
              accounts[0]

            setActiveAccountSource(chosen.source)
            const creds = getCachedCredentials() ?? chosen.credentials

            syncAuthJson(creds)

            // Only an explicit choice becomes a pin. authorize() also runs with
            // no inputs — a first run, or any flow that re-enters provider auth
            // — and persisting the fallback account there records a pin nobody
            // asked for. With pinBlocksRotation on, that silently freezes the
            // balancer: observed as a run that sat on a rate-limited account
            // logging rotate_blocked_by_pin because it was not allowed to move.
            if (inputs?.account) {
              saveAccountSource(chosen.source)
            } else {
              log("authorize_implicit_no_pin", { source: chosen.source })
            }

            const sourceDescription =
              chosen.source === "file"
                ? `credentials file (${chosen.configDir ?? "~/.claude"}/.credentials.json)`
                : `macOS Keychain (${chosen.source})`

            return {
              url: "",
              instructions: `Using ${chosen.label} — credentials loaded from ${sourceDescription}.`,
              method: "auto",
              async callback() {
                return {
                  type: "success",
                  provider: "anthropic",
                  access: creds.accessToken,
                  refresh: creds.refreshToken,
                  expires: creds.expiresAt,
                }
              },
            }
          },
        },
      ],
    },
  }
}

export const ClaudeAuthPlugin = plugin as unknown as Plugin
export default ClaudeAuthPlugin
