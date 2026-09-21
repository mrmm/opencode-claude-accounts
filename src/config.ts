/**
 * File-based configuration.
 *
 * Everything here was previously environment-only, which has two costs: the
 * settings live in a shell profile far from the plugin, and changing one means a
 * new shell and an OpenCode restart. A file can be re-read, so an edit takes
 * effect on the next check without restarting anything.
 *
 * Precedence, least specific first:
 *
 *   defaults
 *     < ~/.config/opencode/claude-auth.jsonc      global
 *     < <project>/claude-auth.jsonc               project
 *     < inline options in opencode.jsonc          per-install
 *     < CLAUDE_AUTH_* environment variables       one-off override
 *
 * Environment stays highest so a single command can still turn something on
 * without editing anything, but it is no longer where configuration lives.
 */

import { type CaptureLevel, isCaptureLevel } from "./introspect.ts"
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_PLACEMENT,
  isAccountLabelPlacement,
  type AccountLabelPlacement,
} from "./ui/display.ts"
import {
  parseKeep,
  parseLevel,
  parseSize,
  reconfigureLogger,
  type LogLevel,
} from "./logger.ts"

export const CONFIG_FILENAME = "claude-auth.jsonc"
export const CONFIG_FILENAME_JSON = "claude-auth.json"

/**
 * Parse a duration: bare milliseconds, or a suffixed value (30s, 5m, 2h, 1d).
 *
 * Returns the fallback for anything unparseable or non-positive -- a zero
 * interval would mean a timer firing continuously, which is worse than ignoring
 * a typo.
 */
export function parseDuration(
  input: string | number | undefined,
  fallback: number,
): number {
  if (input === undefined || input === null || input === "") return fallback
  if (typeof input === "number") {
    return Number.isFinite(input) && input > 0 ? Math.floor(input) : fallback
  }
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(ms|s|m|h|d)?\s*$/i.exec(input)
  if (!m) return fallback
  const n = Number.parseFloat(m[1])
  if (!Number.isFinite(n) || n <= 0) return fallback
  const unit = (m[2] ?? "ms").toLowerCase()
  const mult: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  }
  return Math.floor(n * (mult[unit] ?? 1))
}

/** Parse a 0..1 ratio, also accepting a percentage like "90%" or 90. */
export function parseRatio(
  input: string | number | undefined,
  fallback: number,
): number {
  if (input === undefined || input === null || input === "") return fallback

  const text = String(input)
  const isPercent = typeof input === "string" && text.includes("%")
  const raw =
    typeof input === "number" ? input : Number.parseFloat(text.replace("%", ""))
  if (!Number.isFinite(raw) || raw <= 0) return fallback

  // An explicit "%" is always per-hundred, so "1.5%" is 0.015 as written.
  if (isPercent) {
    const asRatio = raw / 100
    return asRatio > 0 && asRatio <= 1 ? asRatio : fallback
  }

  // A bare number above 1 is read as a percentage, so 90 means 0.9. Between 1
  // and 2 that guess is unsafe: 1.5 is not plausibly "1.5%", it is someone
  // reaching for "above 100%" to disable a threshold — and silently returning
  // 0.015 condemns every account instead of none. Refuse it and keep the
  // default; write "1.5%" if a hundredth and a half is genuinely meant.
  if (raw > 1 && raw < 2) return fallback

  const asRatio = raw > 1 ? raw / 100 : raw
  return asRatio > 0 && asRatio <= 1 ? asRatio : fallback
}

/**
 * Which rate-limit window a switch decision reads. "binding" follows whichever
 * of the two is closer to its limit, so a spent weekly budget moves the
 * account even while the 5h figure still looks healthy.
 */
export type SwitchWindow = "5h" | "7d" | "binding"

const SWITCH_WINDOWS = new Set<string>(["5h", "7d", "binding"])

export function isSwitchWindow(v: unknown): v is SwitchWindow {
  return typeof v === "string" && SWITCH_WINDOWS.has(v)
}

/**
 * Keep the strings, drop everything else, and preserve the order given: the
 * order is the preference order, so it carries meaning beyond membership.
 */
export function parseAccounts(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out = v
    .filter((e): e is string => typeof e === "string")
    .map((e) => e.trim())
    .filter((e) => e.length > 0)
  return [...new Set(out)]
}

/**
 * How one pool chooses among its healthy members.
 *
 * `sticky` is the default because Anthropic's prompt cache is per-account:
 * every move to another account starts that account's cache cold, so a
 * strategy that rotates freely trades cache hits for headroom. The rotating
 * strategies are here for when spreading load matters more than that.
 */
export type BalanceStrategy =
  | "sticky"
  | "priority"
  | "least-loaded"
  | "round-robin"
  | "weighted"
  | "least-used"
  | "random"
  | "p2c"

const STRATEGY_NAMES = new Set<string>([
  "sticky",
  "priority",
  "least-loaded",
  "round-robin",
  "weighted",
  "least-used",
  "random",
  "p2c",
])

export function isBalanceStrategy(v: unknown): v is BalanceStrategy {
  return typeof v === "string" && STRATEGY_NAMES.has(v)
}

/**
 * A group of accounts that share a strategy. Pool order is failover order:
 * a pool is only reached when every pool before it has no healthy member.
 */
export type Pool = {
  name: string
  accounts: string[]
  /** Omitted means the top-level `strategy`. */
  strategy?: BalanceStrategy
  /** Per-account weight for `weighted`; missing entries weigh 1. */
  weights?: Record<string, number>
}

/**
 * Keep only pools that name at least one account. A pool that survives
 * parsing but matches no live account is dropped later, at selection time,
 * where the live account list is known.
 */
/**
 * A flat map of reference to display name. Anything that is not a string pair
 * is dropped rather than rejected wholesale: one bad entry should not cost the
 * others.
 */
export function parseAccountNames(
  v: unknown,
): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (typeof value !== "string") continue
    const name = value.trim()
    const ref = key.trim()
    if (ref === "" || name === "") continue
    out[ref] = name
  }
  return out
}

/**
 * A map of account reference to positive weight. Non-numeric, zero and negative
 * entries are dropped rather than rejecting the whole map: one bad weight
 * should not silently flatten the others back to 1.
 */
/** Sentinels: a parser that falls back is indistinguishable from one that parsed. */
const UNSET_RATIO = -1
const UNSET_DURATION = -1

export function parseWeights(v: unknown): Record<string, number> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined
  const out: Record<string, number> = {}
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) out[k] = n
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function parsePools(v: unknown): Pool[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: Pool[] = []
  for (const [i, raw] of v.entries()) {
    if (!raw || typeof raw !== "object") continue
    const r = raw as Record<string, unknown>
    const accounts = parseAccounts(r.accounts)
    if (!accounts || accounts.length === 0) continue
    const pool: Pool = {
      name:
        typeof r.name === "string" && r.name.trim()
          ? r.name.trim()
          : `pool${i}`,
      accounts,
    }
    if (isBalanceStrategy(r.strategy)) pool.strategy = r.strategy
    const weights = parseWeights(r.weights)
    if (weights) pool.weights = weights
    out.push(pool)
  }
  return out
}

/**
 * A named, selectable configuration: which accounts, in what order, under which
 * strategy.
 *
 * Presets exist because the useful unit of choice is not one account but one
 * *arrangement* — "round-robin over 1 and 2" is a thing you switch to, and
 * spelling it out in the config each time you change your mind is not. They are
 * offered as rows in the account switcher alongside the individual accounts.
 */
export type Preset = {
  /** Shown in the switcher; defaults to the key. */
  label?: string
  strategy?: BalanceStrategy
  /** Accounts in priority order. Ignored when `pools` is set. */
  accounts?: string[]
  /**
   * Per-account weight for `weighted`; missing entries weigh 1.
   *
   * Lives on the preset because strategy does: a preset is a strategy plus the
   * accounts it runs over, and a weight is meaningless without both. Ignored
   * when `pools` is set, where each tier carries its own.
   */
  weights?: Record<string, number>
  /**
   * Behaviour this arrangement overrides.
   *
   * The top-level settings are the defaults; anything a preset names replaces
   * them while that preset is selected, and anything it omits is inherited. A
   * preset is a complete description of how to balance, so the knobs that
   * change balancing belong to it -- an arrangement that needs to switch at 80%
   * should not require editing the global before selecting it, and back again
   * afterwards.
   */
  autoSwitch?: boolean
  switchAt?: number
  switchWindow?: SwitchWindow
  ejectFor?: number
  /** Failover tiers, for a preset that needs more than one. */
  pools?: Pool[]
}

export function parsePresets(v: unknown): Record<string, Preset> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined
  const out: Record<string, Preset> = {}
  for (const [name, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue
    const r = raw as Record<string, unknown>
    const preset: Preset = {}
    if (typeof r.label === "string" && r.label.trim())
      preset.label = r.label.trim()
    if (isBalanceStrategy(r.strategy)) preset.strategy = r.strategy
    const accounts = parseAccounts(r.accounts)
    if (accounts && accounts.length > 0) preset.accounts = accounts
    const pools = parsePools(r.pools)
    if (pools && pools.length > 0) preset.pools = pools
    const weights = parseWeights(r.weights)
    if (weights) preset.weights = weights

    // Behaviour overrides, each optional and each inherited when absent. Parsed
    // with the same functions the top level uses, so a value legal there is
    // legal here and no second notion of validity exists.
    if (typeof r.autoSwitch === "boolean") preset.autoSwitch = r.autoSwitch
    const at = parseRatio(
      r.switchAt as string | number | undefined,
      UNSET_RATIO,
    )
    if (at !== UNSET_RATIO) preset.switchAt = at
    if (isSwitchWindow(r.switchWindow)) preset.switchWindow = r.switchWindow
    const eject = parseDuration(
      r.ejectFor as string | number | undefined,
      UNSET_DURATION,
    )
    if (eject !== UNSET_DURATION) preset.ejectFor = eject
    // A preset that names no accounts and no pools would silently mean "all of
    // them", which is not what anyone writes a preset for.
    if (!preset.accounts && !preset.pools) continue
    out[name] = preset
  }
  return out
}

export type ClaudeAuthConfig = {
  /** false disables logging; true uses the default path; a string is a path. */
  debug: boolean | string
  logLevel: LogLevel
  /** Event selection spec, e.g. "refresh,quota" or "-keychain". */
  logEvents: string
  logMaxSizeBytes: number
  logKeep: number
  /**
   * Whether paid overflow may be used at all.
   *
   * Off means an account whose included allowance is spent is treated as
   * spent, full stop, even when credits would cover it -- the plugin stops
   * rather than bills. It cannot turn credits off at Anthropic (no API offers
   * that, and this credential may not anyway); it declines to ROUTE to them,
   * which keeps this plugin's traffic free while another client's is not.
   */
  useCredits: boolean

  /** Probe every account once per session so each switcher row shows quota. */
  quotaProbe: boolean
  /** Also toast on a successful refresh (failures always toast). */
  toastOnRefresh: boolean
  accountLabel: AccountLabelPlacement

  /** How often the background timer checks whether a refresh is due. */
  refreshCheckInterval: number
  /** How long before expiry a token is refreshed. */
  refreshBeforeExpiry: number
  /** How long the same toast is suppressed after being shown once. */
  noticeCooldown: number
  /** How long a quota reading is reused before an account is re-probed. */
  quotaProbeMaxAge: number
  /** Beyond this age a cached quota reading is ignored entirely. */
  quotaMaxAge: number
  /** 5h utilisation at or above which the active account is flagged. */
  quotaWarnAt: number
  /** Weekly utilisation at or above which the account is flagged. */
  quotaWeeklyWarnAt: number
  /** An alternative account is only suggested at or below this utilisation. */
  quotaAlternativeAt: number
  /** How often the config file itself is re-checked for edits. */
  configReloadInterval: number

  /**
   * Which accounts may serve requests, in preference order, by Keychain
   * source. Empty means every account the Keychain offers. An entry that
   * matches nothing is ignored, so a stale config cannot strand the plugin
   * with no usable account.
   */
  accounts: string[]
  /**
   * Per-account weight for `weighted` on the flat (non-pool) path.
   *
   * A pool carries its own; this is for the case where there are no pools, and
   * without it `weighted` degrades to round-robin while still calling itself
   * weighted.
   */
  weights: Record<string, number>
  /**
   * Move to another account by itself when the active one runs out. Off by
   * default: changing which subscription serves a request is the kind of
   * thing that should be asked for rather than assumed.
   */
  autoSwitch: boolean
  /** Utilisation at or above which the active account is abandoned. */
  switchAt: number
  /** Also move when Anthropic actually refuses a request (429). */
  switchOn429: boolean
  /** Which window `switchAt` is measured against. */
  switchWindow: SwitchWindow
  /**
   * Bind an account to each session, so parallel subagents — which arrive as
   * their own sessions — run on different accounts instead of queueing against
   * one subscription. "none" restores one account per process.
   */
  bindBy: "none" | "session"
  /**
   * A pin names one specific account, so honour it: do not move off it on
   * threshold or refusal. Turn off to let a pin be only a starting point.
   */
  pinBlocksRotation: boolean
  /** Strategy for pools that do not name their own. */
  strategy: BalanceStrategy
  /**
   * Failover tiers, tried in order. Empty means one implicit pool holding
   * `accounts` (or every Keychain account when that is empty too), so the
   * simple single-tier case needs no pool declaration at all.
   */
  pools: Pool[]
  /**
   * How long an account stays ejected after being found spent without a reset
   * time to trust. Multiplied by consecutive ejections, so a repeatedly
   * exhausted account backs off instead of being retried every cycle.
   */
  ejectFor: number
  /**
   * Register the claude_auth_* tools with OpenCode. They are convenient, and
   * they are not free: every description sits in the model's context for the
   * whole session, and the agent can call them. Turn them off to keep the CLI
   * as the only front door.
   */
  tools: boolean
  /**
   * Record the SHAPE of outgoing requests for later analysis: which system
   * blocks, how large, which tools, how much is cacheable. "off" by default
   * because a request body contains the conversation.
   *
   *   shape     sizes, hashes, an 80-character head
   *   full      + system text, so a block can be traced to its source file
   *   messages  + the conversation itself, verbatim on disk
   *
   * "messages" is for answering a specific question over a few minutes and then
   * turning off again. It is hot-reloadable like every other key, so it can be
   * switched on and off without restarting anything.
   */
  /**
   * Retry once, without the trailing assistant message, when a model refuses an
   * assistant prefill with 400.
   *
   * Off by default because the recovery is lossy: it drops the partial
   * assistant turn OpenCode was asking the model to continue. On the models
   * that refuse prefill that turn cannot be sent at all, so the choice is
   * between losing it and a session that fails identically on every retry.
   */
  /**
   * Display names for accounts, keyed by the same references presets accept:
   * an exact Keychain source, or a fragment of the account's label.
   *
   * Only the UI reads this. Nothing about routing changes, which is why a name
   * here can be anything at all -- it is a label, not an identifier.
   */
  accountNames: Record<string, string>
  retryPrefillError: boolean
  captureRequests: CaptureLevel
  /** Named, switchable arrangements. Offered as rows in the switcher. */
  presets: Record<string, Preset>
  /**
   * Preset applied when nothing has been chosen in the switcher. The switcher's
   * choice is remembered and wins over this.
   */
  preset: string
}

export const DEFAULT_CONFIG: ClaudeAuthConfig = {
  debug: false,
  logLevel: "info",
  logEvents: "",
  logMaxSizeBytes: 5 * 1024 * 1024,
  logKeep: 3,
  useCredits: true,
  quotaProbe: false,
  toastOnRefresh: false,
  accountLabel: DEFAULT_PLACEMENT,

  refreshCheckInterval: 5 * 60_000,
  refreshBeforeExpiry: 60 * 60_000,
  noticeCooldown: 10 * 60_000,
  quotaProbeMaxAge: 10 * 60_000,
  quotaMaxAge: 12 * 60 * 60_000,
  quotaWarnAt: 0.9,
  quotaWeeklyWarnAt: 0.85,
  quotaAlternativeAt: 0.7,
  configReloadInterval: 3000,

  accounts: [],
  weights: {},
  autoSwitch: false,
  switchAt: 0.95,
  switchOn429: true,
  switchWindow: "binding",
  strategy: "sticky",
  bindBy: "session",
  pinBlocksRotation: true,
  pools: [],
  ejectFor: 5 * 60_000,
  accountNames: {},
  retryPrefillError: false,
  captureRequests: "off",
  presets: {},
  preset: "",
  tools: true,
}

/**
 * Strip comments and trailing commas so a commented config file parses.
 *
 * String contents are preserved: a `//` inside a value is data, not a comment.
 */
export function stripJsonc(text: string): string {
  let out = ""
  let inString = false
  let quote = ""
  let inLine = false
  let inBlock = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]

    if (inLine) {
      if (c === "\n") {
        inLine = false
        out += c
      }
      continue
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += c
      if (c === "\\") {
        out += next ?? ""
        i++
      } else if (c === quote) {
        inString = false
      }
      continue
    }
    if (c === '"' || c === "'") {
      inString = true
      quote = c
      out += c
      continue
    }
    if (c === "/" && next === "/") {
      inLine = true
      i++
      continue
    }
    if (c === "/" && next === "*") {
      inBlock = true
      i++
      continue
    }
    out += c
  }

  // Trailing commas before a closing brace or bracket.
  return out.replace(/,(\s*[}\]])/g, "$1")
}

function readFileLayer(path: string): Partial<ClaudeAuthConfig> {
  try {
    if (!existsSync(path)) return {}
    return sanitize(JSON.parse(stripJsonc(readFileSync(path, "utf8"))))
  } catch {
    // A malformed file must not take the plugin down; it simply contributes
    // nothing, and the defaults below still apply.
    return {}
  }
}

const bool = (v: unknown): boolean | undefined => {
  if (typeof v === "boolean") return v
  if (v === "true" || v === "1") return true
  if (v === "false" || v === "0") return false
  return undefined
}

/** Accept a partial, unknown-shaped object and keep only what is valid. */
export function sanitize(raw: unknown): Partial<ClaudeAuthConfig> {
  if (!raw || typeof raw !== "object") return {}
  const r = raw as Record<string, unknown>
  const out: Partial<ClaudeAuthConfig> = {}

  if (typeof r.debug === "string" || typeof r.debug === "boolean") {
    out.debug = r.debug
  }
  if (typeof r.logLevel === "string") out.logLevel = parseLevel(r.logLevel)
  if (typeof r.logEvents === "string") out.logEvents = r.logEvents
  if (r.logMaxSize !== undefined) {
    out.logMaxSizeBytes = parseSize(String(r.logMaxSize))
  }
  if (r.logKeep !== undefined) out.logKeep = parseKeep(String(r.logKeep))

  const credits = bool(r.useCredits)
  if (credits !== undefined) out.useCredits = credits
  const probe = bool(r.quotaProbe)
  if (probe !== undefined) out.quotaProbe = probe

  const toast = bool(r.toastOnRefresh)
  if (toast !== undefined) out.toastOnRefresh = toast

  if (isAccountLabelPlacement(r.accountLabel)) out.accountLabel = r.accountLabel

  if (r.bindBy === "none" || r.bindBy === "session") out.bindBy = r.bindBy

  const pinBlocks = bool(r.pinBlocksRotation)
  if (pinBlocks !== undefined) out.pinBlocksRotation = pinBlocks

  if (isCaptureLevel(r.captureRequests)) out.captureRequests = r.captureRequests

  const tools = bool(r.tools)
  if (tools !== undefined) out.tools = tools

  const autoSwitch = bool(r.autoSwitch)
  if (autoSwitch !== undefined) out.autoSwitch = autoSwitch

  const on429 = bool(r.switchOn429)
  if (on429 !== undefined) out.switchOn429 = on429

  if (isSwitchWindow(r.switchWindow)) out.switchWindow = r.switchWindow
  if (isBalanceStrategy(r.strategy)) out.strategy = r.strategy

  const accounts = parseAccounts(r.accounts)
  if (accounts !== undefined) out.accounts = accounts

  const pools = parsePools(r.pools)
  if (pools !== undefined) out.pools = pools

  const presets = parsePresets(r.presets)
  if (presets !== undefined) out.presets = presets

  if (typeof r.preset === "string") out.preset = r.preset.trim()

  const durations: Array<[keyof ClaudeAuthConfig, unknown]> = [
    ["refreshCheckInterval", r.refreshCheckInterval],
    ["refreshBeforeExpiry", r.refreshBeforeExpiry],
    ["noticeCooldown", r.noticeCooldown],
    ["quotaProbeMaxAge", r.quotaProbeMaxAge],
    ["quotaMaxAge", r.quotaMaxAge],
    ["configReloadInterval", r.configReloadInterval],
    ["ejectFor", r.ejectFor],
  ]
  for (const [key, value] of durations) {
    if (value === undefined) continue
    const parsed = parseDuration(
      value as string | number,
      DEFAULT_CONFIG[key] as number,
    )
    ;(out as Record<string, unknown>)[key] = parsed
  }

  const ratios: Array<[keyof ClaudeAuthConfig, unknown]> = [
    ["quotaWarnAt", r.quotaWarnAt],
    ["quotaWeeklyWarnAt", r.quotaWeeklyWarnAt],
    ["quotaAlternativeAt", r.quotaAlternativeAt],
    ["switchAt", r.switchAt],
  ]
  for (const [key, value] of ratios) {
    if (value === undefined) continue
    ;(out as Record<string, unknown>)[key] = parseRatio(
      value as string | number,
      DEFAULT_CONFIG[key] as number,
    )
  }

  const topWeights = parseWeights(r.weights)
  if (topWeights) out.weights = topWeights

  const names = parseAccountNames(r.accountNames)
  if (names) out.accountNames = names

  if (typeof r.retryPrefillError === "boolean")
    out.retryPrefillError = r.retryPrefillError

  return out
}

/** Highest-precedence layer: the environment. */
/**
 * Environment variable names that predate the derived convention.
 *
 * Deriving CLAUDE_AUTH_LOG_LEVEL from `logLevel` reads better than the
 * CLAUDE_AUTH_DEBUG_LEVEL that is actually shipped — but renaming it would
 * silently stop honouring a variable someone already has exported, and four of
 * these are upstream's. The shipped name wins; the convention applies to keys
 * that do not have one yet.
 */
const ENV_NAME_OVERRIDES: Record<string, string> = {
  logLevel: "CLAUDE_AUTH_DEBUG_LEVEL",
  logEvents: "CLAUDE_AUTH_DEBUG_EVENTS",
  logMaxSizeBytes: "CLAUDE_AUTH_DEBUG_MAX_SIZE",
  logKeep: "CLAUDE_AUTH_DEBUG_KEEP",
  toastOnRefresh: "CLAUDE_AUTH_TOAST_REFRESH",
  switchOn429: "CLAUDE_AUTH_SWITCH_ON_429",
}

/**
 * Environment name for a config key: the shipped name if it has one, otherwise
 * camelCase -> CLAUDE_AUTH_SCREAMING_SNAKE.
 */
export function envNameFor(key: string): string {
  return (
    ENV_NAME_OVERRIDES[key] ??
    `CLAUDE_AUTH_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`
  )
}

/**
 * Keys whose sanitizer reads a differently-named raw field. `logMaxSizeBytes`
 * is the parsed result; `logMaxSize` is the human "4mb" that sanitize() parses.
 * Feeding the parsed name straight back in would be dropped silently.
 */
const ENV_RAW_KEY: Record<string, string> = {
  logMaxSizeBytes: "logMaxSize",
}

type EnvParser = (raw: string) => unknown

/**
 * parseDuration and parseRatio answer with their fallback when the input does
 * not parse, which is right for a config file but wrong here: falling back to
 * the DEFAULT would let a typo'd environment variable silently override a
 * perfectly good value from the config file. A sentinel no real ratio or
 * duration can equal distinguishes "parsed" from "gave up", so an unparseable
 * variable is dropped and the lower layer stands.
 */
const UNPARSED = -1

const strictRatio = (v: string): number | undefined => {
  const r = parseRatio(v, UNPARSED)
  return r === UNPARSED ? undefined : r
}

const strictDuration = (v: string): number | undefined => {
  const r = parseDuration(v, UNPARSED)
  return r === UNPARSED ? undefined : r
}

const strictInt = (v: string): number | undefined => {
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : undefined
}

/**
 * How each key reads its environment variable.
 *
 * Table-driven on purpose. Ten keys had drifted out of the hand-written version
 * — every duration and every ratio — so they were settable in the file and not
 * from the environment, silently. A test asserts this table covers every key in
 * DEFAULT_CONFIG, which makes that class of omission impossible to repeat.
 */
const ENV_PARSERS: Record<string, EnvParser> = {
  debug: (v) => (v === "1" ? true : v === "0" ? false : v),
  logLevel: (v) => v,
  logEvents: (v) => v,
  logMaxSizeBytes: (v) => v,
  logKeep: strictInt,
  useCredits: (v) => v === "1",
  quotaProbe: (v) => v === "1",
  toastOnRefresh: (v) => v === "1",
  accountLabel: (v) => v,
  refreshCheckInterval: (v) =>
    parseDuration(v, DEFAULT_CONFIG.refreshCheckInterval),
  refreshBeforeExpiry: (v) =>
    parseDuration(v, DEFAULT_CONFIG.refreshBeforeExpiry),
  noticeCooldown: strictDuration,
  quotaProbeMaxAge: strictDuration,
  quotaMaxAge: strictDuration,
  configReloadInterval: (v) =>
    parseDuration(v, DEFAULT_CONFIG.configReloadInterval),
  ejectFor: strictDuration,
  quotaWarnAt: strictRatio,
  quotaWeeklyWarnAt: strictRatio,
  quotaAlternativeAt: strictRatio,
  switchAt: strictRatio,
  autoSwitch: (v) => v === "1",
  switchOn429: (v) => v === "1",
  switchWindow: (v) => v,
  strategy: (v) => v,
  bindBy: (v) => v,
  pinBlocksRotation: (v) => v === "1",
  tools: (v) => v === "1",
  weights: (v) => {
    try {
      return parseWeights(JSON.parse(v))
    } catch {
      return undefined
    }
  },
  accountNames: (v) => {
    try {
      return parseAccountNames(JSON.parse(v))
    } catch {
      return undefined
    }
  },
  retryPrefillError: (v) => v === "1",
  captureRequests: (v) => v,
  preset: (v) => v.trim(),
  accounts: (v) => parseAccounts(v.split(",")),
  // Structured values arrive as JSON. Unwieldy to type by hand, but a config
  // surface that silently omits two keys is worse than one that is verbose.
  pools: (v) => {
    try {
      return parsePools(JSON.parse(v))
    } catch {
      return undefined
    }
  },
  presets: (v) => {
    try {
      return parsePresets(JSON.parse(v))
    } catch {
      return undefined
    }
  },
}

/**
 * Read every key from the environment. Values go through sanitize() afterwards,
 * so an unparseable or out-of-range value is dropped exactly as it would be in
 * the config file rather than taking effect unchecked.
 */
export function envLayer(
  env: NodeJS.ProcessEnv = process.env,
): Partial<ClaudeAuthConfig> {
  const raw: Record<string, unknown> = {}
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const value = env[envNameFor(key)]
    if (value === undefined || value === "") continue
    const parser = ENV_PARSERS[key]
    if (!parser) continue
    const parsed = parser(value)
    if (parsed !== undefined) raw[ENV_RAW_KEY[key] ?? key] = parsed
  }
  return sanitize(raw)
}

export function candidatePaths(
  projectDir?: string,
  home: string = homedir(),
): string[] {
  const paths = [
    join(home, ".config", "opencode", CONFIG_FILENAME),
    join(home, ".config", "opencode", CONFIG_FILENAME_JSON),
  ]
  if (projectDir) {
    paths.push(join(projectDir, CONFIG_FILENAME))
    paths.push(join(projectDir, CONFIG_FILENAME_JSON))
  }
  return paths
}

/** Merge layers in order; later wins, and undefined never overwrites. */
export function mergeConfig(
  ...layers: Array<Partial<ClaudeAuthConfig>>
): ClaudeAuthConfig {
  const out = { ...DEFAULT_CONFIG }
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer ?? {})) {
      if (v !== undefined) (out as Record<string, unknown>)[k] = v
    }
  }
  return out
}

export function resolveConfig(
  projectDir?: string,
  inline?: unknown,
): ClaudeAuthConfig {
  return mergeConfig(
    ...candidatePaths(projectDir).map(readFileLayer),
    sanitize(inline),
    envLayer(),
  )
}

// ---------------------------------------------------------------------------
// Live reload
// ---------------------------------------------------------------------------

/**
 * Cached config, invalidated when any candidate file changes.
 *
 * Checked at most every `RECHECK_MS`, and only by stat, so the common path is
 * cheap. This is the reason for a file over environment variables: editing it
 * takes effect without a new shell or an OpenCode restart.
 */
const RECHECK_FALLBACK_MS = 3000

let cached: ClaudeAuthConfig | null = null
let cachedAt = 0
let cachedStamp = ""
let cachedProjectDir: string | undefined
let cachedInline: unknown

function stampFor(paths: string[]): string {
  return paths
    .map((p) => {
      try {
        const s = statSync(p)
        return `${p}:${s.mtimeMs}:${s.size}`
      } catch {
        return `${p}:-`
      }
    })
    .join("|")
}

export function getConfig(
  projectDir: string | undefined = cachedProjectDir,
  inline: unknown = cachedInline,
): ClaudeAuthConfig {
  const now = Date.now()
  const recheck = cached?.configReloadInterval ?? RECHECK_FALLBACK_MS
  if (cached && now - cachedAt < recheck) return cached

  const paths = candidatePaths(projectDir)
  const stamp = stampFor(paths)
  cachedAt = now

  if (cached && stamp === cachedStamp) return cached

  cachedStamp = stamp
  cachedProjectDir = projectDir
  cachedInline = inline
  cached = resolveConfig(projectDir, inline)
  // The logging keys are the one group a running session could not pick up:
  // initLogger() copies them into module state once. This re-applies them when
  // they actually change, so every key in the config behaves the same way.
  reconfigureLogger(cached)
  return cached
}

/** Record the project directory and inline options discovered at plugin start. */
export function primeConfig(
  projectDir?: string,
  inline?: unknown,
): ClaudeAuthConfig {
  cached = null
  cachedAt = 0
  cachedStamp = ""
  cachedProjectDir = projectDir
  cachedInline = inline
  return getConfig(projectDir, inline)
}

export function resetConfigCache(): void {
  cached = null
  cachedAt = 0
  cachedStamp = ""
  cachedProjectDir = undefined
  cachedInline = undefined
}
