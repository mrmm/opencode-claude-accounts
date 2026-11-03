/** @jsxImportSource @opentui/solid */
/**
 * Account visibility and switching, inside the TUI.
 *
 * Why this is a second module rather than more of the server plugin:
 * `PluginInput.tui` is `never`, so the plugin that owns the accounts cannot
 * draw anything. A TUI plugin is a separate module kind (`{ tui }`, never
 * `{ server }`), loaded from `tui.json`, in a different process. The two share
 * state only through files on disk, which is why everything here is a read of
 * the selection file and the quota cache.
 *
 * Why it is worth having: picking an account in the provider auth flow calls
 * authorize() and rewrites auth.json. Writing the selection file does not -- it
 * is what `claude_auth_select` and `pnpm lb` already do, and it switches
 * accounts with no auth flow at all.
 *
 * Install: add the absolute path of this file to ~/.config/opencode/tui.json
 *   { "plugin": ["/path/to/tui/claude-auth-tui.tsx"] }
 *
 * Every display and selection decision lives in ../src/tui/chip.ts, which is
 * tested. This file reads, renders, and writes the selection; nothing else.
 */
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import { createSignal, For, onCleanup, Show } from "solid-js"
import { setupV2 } from "./v2-adapter.tsx"
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs"

import {
  loadPersistedAccountSource,
  refreshAccountsList,
  saveAccountSource,
} from "../dist/credentials.js"
import { readQuotaCache } from "../dist/balance/quota.js"
import { readShapeFile } from "../dist/introspect.js"
import {
  expandGroupRefs,
  liveIdToSource,
  resolveRef,
  selectionRecovery,
} from "../dist/balance/index.js"
import { spentBanner } from "../dist/tui/spent.js"
import { dataFile } from "../dist/paths.js"
import {
  recentRequests,
  requestListRow,
  requestTrace,
} from "../dist/tui/requests.js"
import {
  createGroup,
  deleteGroup,
  groupLabel,
  presetsUsingGroup,
  renameGroup,
  toggleGroupMember,
} from "../dist/tui/groups-edit.js"
import {
  addPool,
  indentJson,
  isFlat,
  knobRows,
  movePool,
  moveRef,
  orderRows,
  poolRows,
  poolsOf,
  presetMembership,
  presetRows,
  refsMembership,
  removePool,
  renamePool,
  setPoolStrategy,
  togglePoolAccount,
  togglePresetAccount,
  validatePresetName,
} from "../dist/tui/presets.js"
import {
  currentUsageIndex,
  readUsage,
  sessionDetail,
  summarizeSessions,
} from "../dist/balance/usage.js"
import { candidatePaths, getConfig, resetConfigCache } from "../dist/config.js"
import { prune, readSamples } from "../dist/balance/samples.js"
import { ceilingFor } from "../dist/balance/caps.js"
import { accountKey } from "../dist/balance/account-key.js"
import {
  allowReserve,
  reserveAllowed,
  revokeReserve,
} from "../dist/balance/sessions.js"
import {
  accountCapRow,
  adviceRows,
  cacheBreakdownBlocks,
  requestsFromUsage,
  worstCacheAccount,
  ceilingView,
  optimizationRows,
  optimizeSidebarRows,
  migrationPreviewRows,
  paletteTitle,
  rankedAdvice,
  toastResult,
  toCacheRows,
  type RequestLike,
} from "../dist/tui/caps-ui.js"
import {
  applyMigration,
  membersForMigration,
  cacheBreakdown,
  cacheImpact,
  cacheStats,
  suggestIds,
} from "../dist/balance/index.js"
import { readIdentityCache } from "../dist/balance/identity.js"
import { namesBySource } from "../dist/balance/accounts-id.js"
import { readFolds, toggleFold, writeFolds } from "../dist/tui/fold.js"
import { groupRows, memberName } from "../dist/tui/groups.js"
import {
  configRows,
  display,
  EDITABLE,
  toLiteral,
  STRATEGY_NAMES,
  optionsFor,
  setJsoncValue,
  validateValue,
} from "../dist/config-edit.js"
import {
  buildPickerOptions,
  formatChip,
  mostRecentlyObserved,
  contextSummary,
  detailRows,
  enabledSources,
  quotaText,
  resetClock,
  sessionRows,
  shortNames,
  sidebarLines,
  toggleAccount,
  utilisation,
  type Health,
} from "../dist/tui/chip.js"
import { BUILD } from "../dist/version.js"
import {
  forecast,
  forecastLines,
  forecastSummaryRows,
  toSourceKeys,
} from "../dist/tui/forecast.js"
import {
  composition,
  latestShapes,
  compositionRows,
  globalRows,
  globalTotals,
  sessionRows as tokenSessionRows,
  sessionTotals,
  chartRows,
  contextSeries,
  dailySeries,
  type Row,
  type ShapeLike,
  type WorkReport,
  workMixRows,
} from "../dist/tui/tokens.js"
import {
  hints,
  optimizeReport,
  sessionCalls,
  traffic,
  trafficRows,
} from "../dist/tui/traffic.js"
import { capturePath } from "../dist/introspect.js"
import { readStore } from "../dist/tui/store.js"
import { spawnSync } from "node:child_process"
import { scanSetup, type SetupScan } from "../dist/tui/setup.js"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { debugReport } from "../dist/tui/debug.js"
import { refreshQuotas, resetProbeBlocks } from "../dist/balance/quota.js"
import {
  allowCredits,
  creditsDenied,
  denyCredits,
} from "../dist/balance/index.js"

/** Set by the sidebar slot, which is the only surface handed a session id. */
let lastSessionId: string | null = null

/** Two small file reads. No Keychain, no network, so polling is cheap. */
const POLL_MS = 4000

function read() {
  const quota = readQuotaCache()
  // currentUsageIndex caches on a 30s TTL, so polling it every few seconds
  // costs a map lookup rather than a scan of the telemetry log.
  const index = currentUsageIndex()
  const requests: Record<string, number> = {}
  for (const [source, entry] of Object.entries(index)) {
    requests[source] = (entry as { requests: number }).requests
  }
  return {
    quota,
    requests,
    selection: loadPersistedAccountSource() ?? "__auto__",
    activeSource: mostRecentlyObserved(quota),
  }
}

// One sidebar section as plain text, for pasting into the prompt.
const sectionText = (sec: { title: string; note?: string; rows: Row[] }) =>
  [`${sec.title} ${sec.note ?? ""}`.trim() + ":"]
    .concat(
      sec.rows.map(
        (r) =>
          `- ${r.label.trim()}: ${r.value}${r.level && r.level !== "ok" ? ` [${r.level}]` : ""}`,
      ),
    )
    .join("\n")

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  // refreshAccountsList(), not listAccounts(): the latter returns the list
  // already in memory, and this is a different process from the plugin that
  // fills it, so it is always empty here. That is what made the chip invisible
  // -- it rendered, with nothing to render.
  //
  // Re-reading the Keychain costs one subprocess per account, which is why the
  // balancer avoids it per request. Here it happens once at start and again
  // when the picker opens, which is also how the account switcher behaves.
  const loadAccounts = (): { source: string; label: string }[] => {
    try {
      return refreshAccountsList().map(
        (a: { source: string; label: string }) => ({
          source: a.source,
          label: a.label,
        }),
      )
    } catch {
      return []
    }
  }

  let accounts = loadAccounts()

  /**
   * The accounts the balancer may actually use.
   *
   * The sidebar and the chip show this, not every account in the Keychain: an
   * account excluded by the allow-list can never serve, so listing it beside
   * the ones that can is a list of four things where only three are true. The
   * toggle dialog deliberately shows the full set, since you cannot re-enable
   * something you cannot see.
   */
  // Config references are ids since the migration; resolve them the way the
  // balancer does, so the TUI and routing agree on what is enabled.
  const refToSource = (ref: string) =>
    resolveRef(ref, accounts as { source: string; label?: string }[])
  const enabled = () =>
    enabledSources(
      accounts,
      expandGroupRefs(getConfig().accounts, getConfig().groups),
      refToSource,
    )
  // In the configured order, which is the order the user ranks accounts in.
  const visible = () =>
    enabled().flatMap((s) => accounts.filter((a) => a.source === s))

  /**
   * Hue means load, and only load.
   *
   * "unknown" is muted rather than green: no reading is not good news, it is
   * an absence of news, and colouring it as healthy would claim something the
   * plugin does not know.
   */
  const healthColour = (h: Health) =>
    h === "critical"
      ? api.theme.current.error
      : // Its own hue, because it is its own fact: the account works, and
        // using it costs money. Warning yellow reads as "nearly out" and
        // success green hides the bill entirely.
        h === "paid"
        ? api.theme.current.info
        : h === "warn"
          ? api.theme.current.warning
          : h === "ok"
            ? api.theme.current.success
            : api.theme.current.textMuted

  /**
   * The only back affordance the dialog API supports.
   *
   * There is no stack to pop: TuiDialogStack.replace() discards the stack and
   * installs one item, and it fires every existing onClose *before* doing so --
   * so onClose cannot tell "escaped" from "moved forward" and is useless for
   * navigation. No dialog-scoped keybinding is exposed either. A selectable row
   * is what remains, and it has the advantage of being visible.
   */
  /**
   * Display names, with the configured overrides applied.
   *
   * Keyed by the same references presets accept -- an exact source or a label
   * fragment -- so a name can be written by hand the way the rest of the config
   * is, and resolved by the balancer's own matcher rather than a second one.
   */
  const displayNames = () =>
    shortNames(
      accounts,
      namesBySource(
        getConfig().accountIds,
        readIdentityCache(),
        getConfig().accountNames,
      ),
      (ref, list) =>
        resolveRef(ref, list as { source: string; label?: string }[]),
    )

  // Surgical write: this file is JSONC and its comments are the only
  // documentation at the point of use, so a parse-and-serialise round
  // trip would delete every one. Temp file then rename, so a crash
  // cannot leave half a config where a whole one was.
  const writeSetting = (key: string, literal: string) => {
    const configFile = candidatePaths()[0]!
    try {
      const before = readFileSync(configFile, "utf8")
      const after = setJsoncValue(before, key, literal)
      if (!after) {
        api.ui.toast({
          variant: "error",
          title: "Not changed",
          message: `Could not edit ${key} safely. The file was left alone.`,
        })
        return
      }
      const tmp = `${configFile}.tmp-${process.pid}`
      writeFileSync(tmp, after, "utf8")
      renameSync(tmp, configFile)
      // getConfig() holds its answer for configReloadInterval and will
      // not re-stat before then, so re-reading here would hand back the
      // config as it was a moment ago -- the write lands and the dialog
      // redraws unchanged. Dropping the cache makes the next read the
      // file.
      resetConfigCache()
      api.ui.toast({
        variant: "success",
        title: key,
        message: `Now ${literal}. Live within the reload interval.`,
      })
    } catch (err) {
      api.ui.toast({
        variant: "error",
        title: "Write failed",
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Utilisation as fractions 0..1 for the ceiling bars. chip's `utilisation`
  // returns whole percents, so divide; undefined stays undefined (nothing read).
  const utilisationOf = (source: string) => {
    const u = utilisation(readQuotaCache(), source)
    return {
      five: u.five === undefined ? undefined : u.five / 100,
      week: u.week === undefined ? undefined : u.week / 100,
    }
  }

  /**
   * Escape, routed to a parent screen instead of closing everything.
   *
   * DialogPrompt declares onCancel and never calls it -- esc is handled by the
   * dialog stack, which pops and calls onClose. So "back" has to come from
   * onClose, and that needs two guards to be safe.
   *
   * replace() fires every existing onClose *before* installing the next screen,
   * so a deliberate navigation would fire it too: `navigating` suppresses that.
   * And the stack still holds the item while its onClose runs, so a handler
   * that itself calls replace() would re-enter the same onClose: `fired` makes
   * each one single-shot. Without both, this is an infinite loop rather than a
   * back button.
   */
  let navigating = false
  const navigate = (fn: () => void) => {
    navigating = true
    try {
      fn()
    } finally {
      navigating = false
    }
  }
  const escapeTo = (back: () => void) => {
    let fired = false
    return () => {
      if (navigating || fired) return
      fired = true
      navigate(back)
    }
  }

  /**
   * A confirmation step for anything that cannot be undone.
   *
   * Toggling an account, renaming one or changing a strategy are all one
   * selection away from being put back. Deleting a preset is not: the accounts,
   * the strategy and the label go with it, and nothing in the TUI can
   * reconstruct them.
   */
  /**
   * One text prompt, shared.
   *
   * DialogPrompt declares `onCancel` and never calls it, so escape is
   * the stack's and has to be routed through `escapeTo` -- a detail
   * worth writing once rather than at each call site.
   */
  const askText = (
    title: string,
    seed: string,
    onConfirm: (value: string) => void,
    onEscape: () => void,
    placeholder = "",
  ) =>
    api.ui.dialog.replace(
      () => (
        <api.ui.DialogPrompt
          title={title}
          placeholder={placeholder}
          value={seed}
          onConfirm={(value: string) => onConfirm(value)}
          onCancel={() => onEscape()}
        />
      ),
      escapeTo(onEscape),
    )

  const confirmThen = (
    title: string,
    message: string,
    act: () => void,
    back: () => void,
  ) =>
    api.ui.dialog.replace(
      () => (
        <api.ui.DialogConfirm
          title={title}
          message={message}
          onConfirm={() => navigate(act)}
          onCancel={() => navigate(back)}
        />
      ),
      escapeTo(back),
    )

  const BACK = "__back__"
  const backRow = (where: string) => ({
    title: "\u2190 Back",
    value: BACK,
    description: `to ${where}`,
  })

  const [snap, setSnap] = createSignal(read())
  const timer = setInterval(() => setSnap(read()), POLL_MS)
  onCleanup(() => clearInterval(timer))

  // The pace forecast scans up to two generations of the telemetry log, so it
  // refreshes on its own slower clock rather than on every quota poll.
  const FORECAST_MS = 60_000
  // Ceilings the pool is allowed to spend, keyed by source for the forecast.
  // The config stores them by account id, so each source is resolved to its id
  // first; an un-migrated account keys by its own source and reads no ceiling.
  const forecastCeilings = (sources: string[]) => {
    const cfg = getConfig()
    const out: Record<string, { five: number; week: number }> = {}
    for (const source of sources) {
      const id = accountKey(source)
      out[source] = {
        five: ceilingFor(cfg, id, "5h"),
        week: ceilingFor(cfg, id, "7d"),
      }
    }
    return out
  }
  const readForecast = () => {
    try {
      const sources = visible().map((a) => a.source)
      // The compact samples file is the long memory (8 days); the request log
      // rotates under a day. Prefer samples, but fall back to the log when the
      // samples do not yet cover an hour — a fresh install has none.
      // prune: rows past retention (or stray fixture rows from long ago) would
      // stretch the time axis and flatten every pace to zero.
      const samples = prune(readSamples(), Date.now()).map((s) => ({
        account: s.account,
        at: s.at,
        u5: s.u5,
        u7: s.u7,
        reqs: s.reqs,
        input: s.input,
        output: s.output,
        cacheRead: s.cacheRead,
        cacheWrite: s.cacheWrite,
      }))
      const spanMs =
        samples.length > 0
          ? Math.max(...samples.map((s) => s.at)) -
            Math.min(...samples.map((s) => s.at))
          : 0
      const paceSamples =
        spanMs >= 3_600_000
          ? samples
          : readUsage(Date.now() - 7 * 86_400_000).flatMap((e) =>
              e.kind === "request"
                ? [
                    {
                      account: e.account,
                      at: e.created_at,
                      u5: e.utilization_5h,
                      u7: e.utilization_7d,
                    },
                  ]
                : [],
            )
      const f = forecast(
        toSourceKeys(paceSamples, liveIdToSource),
        readQuotaCache(),
        sources,
        undefined,
        {
          ceilings: forecastCeilings(sources),
        },
      )
      // Per-account forecast lines are keyed by account id, which is what the
      // ceilings and the config are keyed by, so a line about a reserved account
      // names the id the operator would edit.
      const names = displayNames()
      const idNames = new Map(
        sources.map((s) => {
          const id = accountKey(s)
          const name = names.get(s)
          return [s, id === s ? (name ?? s) : name ? `${id} ${name}` : id]
        }),
      )
      const clock = (epoch: number) => resetClock(epoch)
      return {
        summary: forecastSummaryRows(f, clock, names),
        lines: forecastLines(f, clock, idNames),
        now: f.idle ? undefined : `${Math.round(f.nowPace * 100)}%/h`,
      }
    } catch {
      return { summary: [] as Row[], lines: [] as Row[], now: undefined }
    }
  }
  const [pace, setPace] = createSignal(readForecast())
  const paceTimer = setInterval(() => setPace(readForecast()), FORECAST_MS)
  onCleanup(() => clearInterval(paceTimer))

  // Global token totals come from OpenCode's own store (real counts, every session),
  // opened read-only. bun:sqlite exists only inside the host, hence the dynamic import;
  // without it the section says so instead of guessing.
  const dbPath = join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "opencode",
    "opencode.db",
  )
  type Global = {
    totals?: ReturnType<typeof globalTotals>
    tools?: ReturnType<typeof traffic>
    daily?: number[]
    error?: string
  }
  const readGlobal = async (): Promise<Global> => {
    try {
      const { Database } = (await import("bun:sqlite" as string)) as {
        Database: new (
          p: string,
          o: { readonly: boolean },
        ) => {
          query: (sql: string) => { all: (...a: unknown[]) => unknown[] }
          close: () => void
        }
      }
      const db = new Database(dbPath, { readonly: true })
      try {
        // Every session and tool call OpenCode recorded: the traffic is already on disk.
        const { sessions: rows, calls } = readStore(
          (sql, since) => db.query(sql).all(since),
          Date.now() - 7 * 86_400_000,
        )
        return {
          totals: globalTotals(rows),
          tools: traffic(calls),
          daily: dailySeries(
            rows as unknown as Parameters<typeof dailySeries>[0],
            Date.now(),
          ),
        }
      } finally {
        db.close()
      }
    } catch (e) {
      return {
        error:
          "store unreadable: " +
          String((e as Error)?.message ?? e).slice(0, 40),
      }
    }
  }
  // The newest captured request: the only place the prompt's composition exists. Read
  // from the file's tail so an 8 MB capture is not parsed every minute.
  const readComposition = (): Map<string, ShapeLike> | string => {
    if (
      (getConfig() as { captureRequests?: string }).captureRequests === "off" ||
      !(getConfig() as { captureRequests?: string }).captureRequests
    ) {
      return "set captureRequests: shape"
    }
    try {
      const fd = openSync(capturePath(), "r")
      try {
        const size = fstatSync(fd).size
        const len = Math.min(size, 2 * 1024 * 1024)
        const buf = Buffer.alloc(len)
        readSync(fd, buf, 0, len, size - len)
        return latestShapes(buf.toString("utf-8").trimEnd().split("\n"))
      } finally {
        closeSync(fd)
      }
    } catch {
      return "no capture yet"
    }
  }
  // A work report another tool wrote (cost and weekly quota per kind of work); absent = no section.
  const workReportPath = () => join(dirname(capturePath()), "work-report.json")
  const readWork = (): Row[] => {
    try {
      const r = JSON.parse(readFileSync(workReportPath(), "utf8")) as WorkReport
      return Array.isArray(r.rows) ? workMixRows(r) : []
    } catch {
      return []
    }
  }
  const [work, setWork] = createSignal(readWork())
  const [globalTok, setGlobalTok] = createSignal<Global>({})
  const [compo, setCompo] = createSignal(readComposition())
  // The 7-day scan reads every tool part (~1 s on a busy store), so it runs every 5 min;
  // the capture tail is cheap and follows the forecast's minute.
  const refreshGlobal = () => {
    setWork(readWork())
    void readGlobal().then(setGlobalTok)
  }
  refreshGlobal()
  const globalTimer = setInterval(refreshGlobal, 5 * FORECAST_MS)
  const compoTimer = setInterval(() => setCompo(readComposition()), FORECAST_MS)
  onCleanup(() => {
    clearInterval(globalTimer)
    clearInterval(compoTimer)
  })
  const globalTokRows = (): Row[] => {
    const g = globalTok()
    if (g.error) return [{ label: "7 days", value: g.error, level: "warn" }]
    return g.totals ? globalRows(g.totals, "7 days") : []
  }
  // This session's newest request; another session's would describe the wrong prompt.
  const compoOf = (id: string) => {
    const c = compo()
    if (typeof c === "string") return c
    const shape = c.get(id)
    return shape
      ? composition(shape)
      : "no request from this session in the capture"
  }
  const compoRows = (id: string): Row[] => {
    const c = compoOf(id)
    return typeof c === "string"
      ? [
          {
            label: "request",
            value: c,
            level: c.startsWith("set") ? "warn" : "ok",
          },
        ]
      : compositionRows(c)
  }

  // What the setup loads (instruction files, duplicate agents), cached per directory:
  // the sidebar re-renders constantly and these files change rarely.
  const scans = new Map<string, { at: number; scan: SetupScan }>()
  const setupOf = (directory: string): SetupScan => {
    const hit = scans.get(directory)
    if (hit && Date.now() - hit.at < FORECAST_MS) return hit.scan
    const scan = scanSetup(
      directory,
      homedir(),
      process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    )
    scans.set(directory, { at: Date.now(), scan })
    return scan
  }
  const sessionDir = (id: string) =>
    api.state.session.get(id)?.directory ?? api.state.path.directory

  // Advice ranked by quota impact, priced with the documented cache model and
  // this session's measured misses. Complements `hints` (which ranks by raw
  // token weight): this one puts a per-day token saving on each item, so the
  // order is the 80/20 of where the quota actually goes.
  // This session's request rows from the last 24h. The sidebar re-renders
  // constantly and the usage log is megabytes, so one read serves 5 seconds.
  let dayCache: { at: number; rows: RequestLike[] } | undefined
  const dayRequests = (): RequestLike[] => {
    if (dayCache && Date.now() - dayCache.at < 5_000) return dayCache.rows
    dayCache = {
      at: Date.now(),
      rows: requestsFromUsage(readUsage(Date.now() - 24 * 60 * 60_000)),
    }
    return dayCache.rows
  }
  const sessionRequests = (id: string): RequestLike[] =>
    dayRequests().filter((r) => r.session === id)
  // Account ids in configured order, and a display name per id: the cache
  // breakdown is keyed by id, the sidebar and names by Keychain source.
  const idOrder = () => visible().map((a) => accountKey(a.source))
  const idNames = () => {
    const names = displayNames()
    return new Map(
      visible().map((a) => [
        accountKey(a.source),
        names.get(a.source) ?? a.label,
      ]),
    )
  }
  let worstCache:
    | { at: number; w?: { name: string; hitRate: number } }
    | undefined
  const worstAccount = () => {
    if (worstCache && Date.now() - worstCache.at < 5_000) return worstCache.w
    const w = worstCacheAccount(cacheBreakdown(toCacheRows(dayRequests())))
    worstCache = {
      at: Date.now(),
      w: w && {
        name: idNames().get(w.account) ?? w.account,
        hitRate: w.hitRate,
      },
    }
    return worstCache.w
  }

  const rankedFixes = (id: string, c: ReturnType<typeof compoOf>): Row[] => {
    const rows = sessionRequests(id)
    if (rows.length === 0) return []
    const cfg = getConfig()
    const comp = typeof c === "string" ? undefined : c
    const latest = rows[rows.length - 1]!
    const advice = rankedAdvice({
      cache: cacheStats(toCacheRows(rows)),
      spanDays: Math.max(
        1 / 24,
        (latest.created_at - rows[0]!.created_at) / 86_400_000,
      ),
      opus: /opus/.test(latest.model),
      instructionTokens: comp?.instructions,
      toolTokens: comp?.tools,
      avgContext:
        typeof c === "string"
          ? undefined
          : sessionTotals(api.state.session.messages(id)).lastContext,
      contextTrigger: 100_000,
      contextEditingOn: cfg.contextEditing !== false,
    })
    return adviceRows(advice)
  }

  type Section = { title: string; note?: string; rows: Row[] }
  // One source for the sidebar, the new-session toast and /optimize, so all three agree.
  const report = (id: string): Section[] => {
    const messages = api.state.session.messages(id)
    const totals = sessionTotals(messages)
    const calls = traffic(sessionCalls(messages, (m) => api.state.part(m)))
    const c = compoOf(id)
    const g = globalTok()
    const setup = setupOf(sessionDir(id))
    const advice = hints({
      session: totals,
      traffic: calls,
      composition: typeof c === "string" ? undefined : c,
      global: g.totals,
      files: setup.files,
      duplicateAgents: setup.duplicateAgents,
    })
    const ranked = rankedFixes(id, c)
    return [
      { title: "Optimize", note: "(biggest first, /optimize)", rows: advice },
      {
        title: "Forecast",
        note: "(per account, ours vs outside)",
        rows: pace().lines,
      },
      {
        title: "Charts",
        note: "(context per turn, reads per day)",
        rows: chartRows(contextSeries(messages), g.daily ?? []),
      },
      {
        title: "Tokens",
        note: "(this session)",
        rows: tokenSessionRows(totals),
      },
      {
        title: "Tool output",
        note: "(this session, ↻ = re-read)",
        rows: trafficRows(calls, true),
      },
      { title: "Tokens", note: "(all sessions)", rows: globalTokRows() },
      {
        title: "Tool output",
        note: "(7 days)",
        rows: g.tools ? trafficRows(g.tools, false) : [],
      },
      {
        title: "Work mix",
        note: "(cost · quota, → on routed models)",
        rows: work(),
      },
      { title: "Last request", note: "(est., bytes/3.7)", rows: compoRows(id) },
      ...(ranked.length
        ? [
            {
              title: "Ranked fixes",
              note: "(by quota/day, priced)",
              rows: ranked,
            },
          ]
        : []),
    ]
  }

  // The full report: what /optimize sends and what /tokens copies.
  const reportText = (id: string) => {
    const directory = sessionDir(id)
    const setup = setupOf(directory)
    return optimizeReport({
      directory,
      files: setup.files,
      duplicateAgents: setup.duplicateAgents,
      sections: report(id).map((sec) => ({
        title: `${sec.title} ${sec.note ?? ""}`.trim(),
        rows: sec.rows,
      })),
    })
  }

  // System clipboard, by platform. Returns false when no tool is available.
  const copyText = (text: string): boolean => {
    const tools: [string, string[]][] =
      process.platform === "darwin"
        ? [["pbcopy", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ]
    for (const [cmd, args] of tools) {
      const r = spawnSync(cmd, args, {
        input: text,
        timeout: 3_000,
        env: process.env,
      })
      if (r.status === 0) return true
    }
    return false
  }
  // Into the prompt box: copy, then the TUI's own paste command, so nothing is sent
  // until you press enter. Without the command, the text stays on the clipboard.
  const toPrompt = (text: string, what: string) => {
    if (!copyText(text)) {
      writeFileSync(dataFile("optimize.md"), text)
      api.ui.toast({
        variant: "warning",
        message: `No clipboard tool; ${what} saved to ~/.local/share/opencode/claude-auth/optimize.md`,
      })
      return
    }
    const dispatch = (api.keymap as { dispatch?: (id: string) => void })
      .dispatch
    if (typeof dispatch === "function") {
      // After the dialog has closed, or the paste lands in the dialog.
      setTimeout(() => dispatch("prompt.paste"), 50)
      api.ui.toast({
        variant: "success",
        message: `${what} pasted into the prompt`,
      })
    } else {
      api.ui.toast({
        variant: "success",
        message: `${what} copied; paste with ctrl+v`,
      })
    }
  }

  // Sent as a normal user message: the agent answers with a plan, and the report says
  // not to change anything before approval. If sending fails, the report lands in a file.
  const sendOptimize = (sid: string) => {
    const text = reportText(sid)
    const fallback = (why: string) => {
      const file = dataFile("optimize.md")
      writeFileSync(file, text)
      api.ui.toast({
        variant: "warning",
        message: `optimize: ${why}. Report saved to ${file.replace(homedir(), "~")}`,
        duration: 10_000,
      })
    }
    const send = api.client?.session?.promptAsync
    if (typeof send !== "function") return fallback("no client in this TUI")
    void api.client.session
      .promptAsync({ sessionID: sid, parts: [{ type: "text", text }] })
      .then((res) => {
        if (res.error) fallback(String(JSON.stringify(res.error)).slice(0, 80))
      })
      .catch((e: unknown) =>
        fallback(String((e as Error)?.message ?? e).slice(0, 80)),
      )
  }

  const openDetails = (id: string) => {
    const sections = report(id)
    const options = [
      {
        title: "Paste full report into prompt",
        value: "paste",
        category: "Actions",
      },
      {
        title: "Copy full report to clipboard",
        value: "copy",
        category: "Actions",
      },
      {
        title: "Ask the agent for a fix plan (/optimize)",
        value: "optimize",
        category: "Actions",
      },
      ...sections.flatMap((sec, i) =>
        sec.rows.map((r, j) => ({
          title: r.label.trim(),
          description: r.value,
          value: `sec:${i}:${j}`,
          category: `${sec.title} ${sec.note ?? ""}`.trim(),
        })),
      ),
    ]
    api.ui.dialog.replace(() => (
      <api.ui.DialogSelect
        title="Token usage · enter on a row pastes its section"
        options={options}
        onSelect={(row: { value: unknown }) => {
          const v = String(row.value)
          if (v === "paste") return toPrompt(reportText(id), "Report")
          if (v === "copy")
            return api.ui.toast(
              copyText(reportText(id))
                ? { variant: "success", message: "Report copied to clipboard" }
                : { variant: "warning", message: "No clipboard tool found" },
            )
          if (v === "optimize") return void sendOptimize(id)
          const sec = sections[Number(v.split(":")[1])]
          if (sec) toPrompt(sectionText(sec), sec.title)
        }}
      />
    ))
  }

  // New top-level session, any worktree: say what is worth fixing, without spending a
  // token on it. Subagent sessions are skipped; they inherit the same setup. The
  // sidebar slot renders for whichever session is on screen, so the toast keys off
  // that: the V2 adapter has no event bus, and this works on both runtimes.
  const toasted = new Set<string>()
  const maybeToast = (id: string) => {
    if (toasted.has(id)) return
    const info = api.state.session.get(id) as
      | { parentID?: string; time?: { created?: number } }
      | undefined
    if (!info) return // not loaded yet: the next render tries again
    toasted.add(id)
    // Only fresh sessions; reopening an old one is not the moment.
    const created = info.time?.created ?? 0
    if (info.parentID || Date.now() - created > 2 * 60_000) return
    const worth = report(id)[0]!.rows.filter((r) => r.level && r.level !== "ok")
    if (worth.length === 0) return
    api.ui.toast({
      variant: worth.some((r) => r.level === "critical") ? "warning" : "info",
      title: "Token savings available",
      message:
        worth
          .slice(0, 2)
          .map((r) => `${r.label.trim()}: ${r.value}`)
          .join("\n") + "\nRun /optimize for a fix plan.",
      duration: 10_000,
    })
  }

  const levelColour = (l?: string) =>
    l === "critical"
      ? api.theme.current.error
      : l === "warn"
        ? api.theme.current.warning
        : api.theme.current.textMuted
  // One look for every section: a bold heading, then label/value rows with the labels in
  // a fixed column, so numbers line up down the sidebar.
  const Rows = (props: { rows: Row[] }) => (
    <For each={props.rows}>
      {(row) => (
        <box flexDirection="row" gap={1}>
          <text flexShrink={0} width={12} fg={api.theme.current.textMuted}>
            {row.label}
          </text>
          <text
            style={{
              fg:
                row.level && row.level !== "ok"
                  ? levelColour(row.level)
                  : row.tone === "burn"
                    ? api.theme.current.accent
                    : row.tone === "projection"
                      ? api.theme.current.primary
                      : row.tone === "axis"
                        ? api.theme.current.textMuted
                        : api.theme.current.text,
            }}
          >
            {row.value}
          </text>
        </box>
      )}
    </For>
  )
  const [folds, setFolds] = createSignal(readFolds())
  const isFolded = (key: string) => folds()[key] === true
  const toggleSection = (key: string) => {
    const next = toggleFold(folds(), key)
    setFolds(next)
    writeFolds(next)
  }
  const Heading = (props: { title: string; note?: string; fold?: string }) => (
    <text
      fg={api.theme.current.text}
      onMouseUp={() => props.fold && toggleSection(props.fold)}
    >
      {props.fold ? (isFolded(props.fold) ? "\u25b8 " : "\u25be ") : ""}
      <b>{props.title}</b>
      <span style={{ fg: api.theme.current.textMuted }}>
        {props.note ? ` ${props.note}` : ""}
      </span>
    </text>
  )
  // A clickable label. Mouse-up, not down: a press that drags off cancels, as in
  // every other TUI button.
  const Button = (props: { label: string; onClick: () => void }) => {
    const [hover, setHover] = createSignal(false)
    return (
      <box
        onMouseUp={() => props.onClick()}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
      >
        <text fg={hover() ? api.theme.current.text : api.theme.current.info}>
          [{props.label}]
        </text>
      </box>
    )
  }
  // Everything the sidebar reads, now instead of on the next timer tick.
  const refreshAll = () => {
    scans.clear()
    setPace(readForecast())
    setCompo(readComposition())
    setWork(readWork())
    void readGlobal().then((g) => {
      setGlobalTok(g)
      api.ui.toast({
        variant: "success",
        message: "Token stats refreshed",
        duration: 2_000,
      })
    })
  }

  // One picker for the palette command and for clicks on the chip or sidebar.
  const openAccountPicker = () => {
    // Notice an account added since start-up, the way the switcher does.
    accounts = loadAccounts()
    const current = snap()
    const options = buildPickerOptions({
      accounts: visible(),
      names: displayNames(),
      presets: getConfig().presets,
      quota: current.quota,
      selection: current.selection,
      resetFormat: getConfig().resetFormat,
    })
    // A per-session choice belongs beside the per-session account, not in
    // the global settings screen. Offered only when there is a session to
    // attach it to, and only when credits are globally allowed -- a row
    // that cannot change the outcome is worse than an absent one.
    const sid = lastSessionId
    const canDecline = sid !== null && getConfig().useCredits
    const CREDITS = "__credits_toggle__"
    const RESERVE = "__reserve_toggle__"
    if (canDecline) {
      const off = creditsDenied(sid)
      options.push({
        title: off
          ? "Paid credits: declined for this session"
          : "Paid credits: allowed for this session",
        value: CREDITS,
        description: off
          ? "this session stops instead of spending once every allowance is gone"
          : "this session may spend overflow once every allowance is gone",
        category: "This session",
      })
    }
    // Reserved quota: an account past its ceiling is held back, unless a session
    // opts in. Offered whenever there is a session to attach the choice to; the
    // global capMode still governs every other session.
    if (sid !== null) {
      const on = reserveAllowed(sid)
      options.push({
        title: on
          ? "Use reserved quota in this session: on"
          : "Use reserved quota in this session: off",
        value: RESERVE,
        description: on
          ? "this session may spend an account past its ceiling"
          : "this session leaves quota above each ceiling in reserve",
        category: "This session",
      })
    }
    // `dialog` is a stack: `replace` pushes this dialog, `clear` closes
    // it. There is no open()/close() pair.
    api.ui.dialog.replace(() => (
      <api.ui.DialogSelect
        title={paletteTitle("Accounts", "Switch account or preset")}
        current={current.selection}
        options={options}
        onSelect={(option) => {
          if (String(option.value) === CREDITS && sid) {
            // Written to disk, not held in memory: the balancer runs in
            // the server process and would never see a flag set here.
            const off = creditsDenied(sid)
            if (off) allowCredits(sid)
            else denyCredits(sid)
            api.ui.toast({
              variant: "success",
              title: "Paid credits",
              message: off
                ? "This session may spend overflow again."
                : "This session will stop rather than spend overflow.",
            })
            api.ui.dialog.clear()
            return
          }
          if (String(option.value) === RESERVE && sid) {
            // Same cross-process pattern as credits: the balancer reads this
            // file, not a flag set in the TUI process.
            const on = reserveAllowed(sid)
            if (on) revokeReserve(sid)
            else allowReserve(sid)
            api.ui.toast({
              variant: "success",
              title: "Reserved quota",
              message: on
                ? "This session leaves reserved quota alone again."
                : "This session may now spend accounts past their ceiling.",
            })
            api.ui.dialog.clear()
            return
          }
          // The whole point: one file write. No authorize(), no auth.json
          // rewrite, no provider rebuild. The next request routes to it.
          saveAccountSource(String(option.value))
          setSnap(read())
          api.ui.dialog.clear()
        }}
      />
    ))
  }

  api.slots.register({
    order: 200,
    slots: {
      session_prompt_right() {
        // No Show gate. Selection and quota come from files and are useful
        // even when the Keychain gives no labels; gating on labels is exactly
        // what made this render as nothing.
        return (
          <box onMouseUp={openAccountPicker}>
            <text fg={api.theme.current.textMuted}>
              {formatChip({ accounts: visible(), ...snap() })}
            </text>
          </box>
        )
      },
    },
  })

  api.slots.register({
    order: 210,
    slots: {
      sidebar_content(_ctx, props: { session_id: string }) {
        // A command carries no session id -- TuiCommand is title/value/keybind
        // and nothing else -- but this slot does, and it re-renders constantly
        // for whichever session is on screen. So the dialogs borrow it here.
        lastSessionId = props.session_id
        maybeToast(props.session_id)
        const view = () =>
          sidebarLines({
            accounts: visible(),
            names: displayNames(),
            hiddenCount: accounts.length - visible().length,
            thresholds: {
              warnAt: getConfig().quotaWarnAt,
              weeklyWarnAt: getConfig().quotaWeeklyWarnAt,
            },
            ...snap(),
          })
        const sections = () =>
          groupRows({
            groups: getConfig().groups,
            accounts: visible(),
            quota: snap().quota,
            requests: snap().requests,
            resolve: refToSource,
            thresholds: {
              warnAt: getConfig().quotaWarnAt,
              weeklyWarnAt: getConfig().quotaWeeklyWarnAt,
            },
          })
        // Read with the quota snapshot so it refreshes when the readings do.
        const spent = () => {
          void snap()
          const r = selectionRecovery()
          return spentBanner({
            ...r,
            nowMs: Date.now(),
            clock: (ms: number) =>
              new Date(ms).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              }),
          })
        }
        // One name column for groups and accounts, so every figure after it
        // starts at the same place whatever the names are.
        const groupLabel = (g: { title: string; count: string }) =>
          `${g.title} ${g.count}`
        // Inside a group a member drops the group's name from its own.
        const shownName = () => {
          const m = new Map<string, string>()
          for (const g of sections())
            for (const s of g.sources) {
              const row = rowBySource().get(s)
              if (row) m.set(s, memberName(g.title, row.name))
            }
          return m
        }
        const nameWidth = () =>
          Math.max(
            0,
            ...(sections().length > 0
              ? [...shownName().values()].map((n) => n.length)
              : view().rows.map((r) => r.name.length)),
            ...sections().map((g) => groupLabel(g).length),
          )
        const rowBySource = () =>
          new Map(visible().map((a, i) => [a.source, view().rows[i]!]))
        type SidebarRow = ReturnType<typeof view>["rows"][number]
        const AccountRow = (props: { row: SidebarRow; name?: string }) => {
          return (
            <box flexDirection="row" gap={1}>
              <text
                flexShrink={0}
                style={{ fg: healthColour(props.row.health) }}
              >
                {props.row.active ? "\u25cf" : "\u00b7"}
              </text>
              <text
                style={{
                  // Brightness says which account is serving; hue says how
                  // it is doing. Two facts, two channels -- the previous
                  // rendering put both on hue and could show neither.
                  fg: props.row.active
                    ? api.theme.current.text
                    : api.theme.current.textMuted,
                }}
              >
                {(props.name ?? props.row.name).padEnd(nameWidth())}
                <span style={{ fg: healthColour(props.row.health) }}>
                  {"  "}
                  {props.row.detail}
                </span>
              </text>
            </box>
          )
        }
        return (
          <box>
            <text
              fg={api.theme.current.text}
              onMouseUp={() => toggleSection("accounts")}
            >
              {isFolded("accounts") ? "\u25b8 " : "\u25be "}
              <b>Claude Auth</b>
              <span style={{ fg: api.theme.current.textMuted }}>
                {` v${BUILD}`}
              </span>
              <span style={{ fg: api.theme.current.textMuted }}>
                {" "}
                ({view().heading})
              </span>
            </text>
            <Show when={spent()}>
              <text fg={api.theme.current.error}>{spent()}</text>
            </Show>
            <Show when={!isFolded("accounts")}>
              <Show
                when={sections().length > 0}
                fallback={
                  <box onMouseUp={openAccountPicker}>
                    <For each={view().rows}>
                      {(row) => <AccountRow row={row} />}
                    </For>
                  </box>
                }
              >
                <For each={sections()}>
                  {(g) => (
                    <box>
                      <text
                        fg={api.theme.current.text}
                        onMouseUp={() => toggleSection(g.key)}
                      >
                        {isFolded(g.key) ? "\u25b8 " : "\u25be "}
                        <b>{groupLabel(g).padEnd(nameWidth())}</b>
                        <span style={{ fg: healthColour(g.health) }}>
                          {`  ${g.summary}`}
                        </span>
                      </text>
                      <Show when={!isFolded(g.key)}>
                        <box onMouseUp={openAccountPicker}>
                          <For each={g.sources}>
                            {(source) => (
                              <Show when={rowBySource().get(source)}>
                                {(row) => (
                                  <AccountRow
                                    row={row()}
                                    name={shownName().get(source)}
                                  />
                                )}
                              </Show>
                            )}
                          </For>
                        </box>
                      </Show>
                    </box>
                  )}
                </For>
              </Show>
            </Show>
          </box>
        )
      },
    },
  })

  api.slots.register({
    order: 211,
    slots: {
      sidebar_content() {
        // The plain answers; per-account lines and charts are in details.
        const windows = () => pace().summary
        const now = () => pace().now
        return (
          <box>
            <Heading
              title="Forecast"
              fold="forecast"
              note={now() ? `(now ${now()})` : undefined}
            />
            <Show when={!isFolded("forecast")}>
              <Rows rows={windows()} />
            </Show>
          </box>
        )
      },
    },
  })

  api.slots.register({
    order: 212,
    slots: {
      sidebar_content(_ctx, props: { session_id: string }) {
        // Short on purpose: the top fixes and one line of usage. Everything else is
        // in /tokens, which can paste it into the prompt.
        const rows = (): Row[] => {
          const id = props.session_id
          const c = compoOf(id)
          const reqs = sessionRequests(id)
          return optimizeSidebarRows({
            session: sessionTotals(api.state.session.messages(id)),
            ...(reqs.length ? { cache: cacheImpact(toCacheRows(reqs)) } : {}),
            ...(worstAccount() ? { worstAccount: worstAccount()! } : {}),
            ...(typeof c === "string" ? {} : { composition: c }),
            hints: report(id)[0]!.rows,
            contextLimit: getConfig().contextLimit,
          })
        }
        return (
          <box>
            <Heading title="Optimize" note="(this session)" fold="optimize" />
            <Show when={!isFolded("optimize")}>
              <Rows rows={rows()} />
              <box flexDirection="row" gap={1}>
                <Button label="↻ refresh" onClick={refreshAll} />
                <Button
                  label="details"
                  onClick={() => openDetails(props.session_id)}
                />
              </box>
              <box flexDirection="row" gap={1}>
                <Button
                  label="→ prompt"
                  onClick={() =>
                    toPrompt(reportText(props.session_id), "Report")
                  }
                />
                <Button
                  label="fix plan"
                  onClick={() => sendOptimize(props.session_id)}
                />
              </box>
            </Show>
          </box>
        )
      },
    },
  })

  api.keymap.registerLayer({
    commands: [
      {
        name: "claude-auth.select",
        title: paletteTitle("Accounts", "Switch account or preset"),
        category: "Claude Auth",
        namespace: "palette",
        slashName: "cc-account",
        run: () => openAccountPicker(),
      },
      {
        name: "claude-auth.requests",
        title: paletteTitle("Diagnostics", "Recent requests"),
        category: "Claude Auth",
        namespace: "palette",
        slashName: "cc-requests",
        run() {
          // The usage log is keyed by account id; names come from the sources.
          const nameOf = (id: string) => {
            const names = displayNames()
            const a = accounts.find((x) => accountKey(x.source) === id)
            return (
              (a && names.get(a.source)) ??
              getConfig().accountIds[id]?.name ??
              id
            )
          }
          const list = (onlySession: boolean) => {
            const rows = recentRequests(
              readUsage(Date.now() - 24 * 3_600_000),
              {
                ...(onlySession && lastSessionId
                  ? { session: lastSessionId }
                  : {}),
                limit: 60,
              },
            )
            api.ui.dialog.replace(() => (
              <api.ui.DialogSelect
                title={`Recent requests (${onlySession ? "this session" : "all sessions"}, 24h)`}
                options={[
                  {
                    title: onlySession
                      ? "Show all sessions"
                      : "Show this session only",
                    value: "__scope__",
                    description: "switch which requests are listed",
                    category: "View",
                  },
                  ...rows.map((e, i) => ({
                    ...requestListRow(e, nameOf),
                    value: `r:${i}`,
                    category: "Requests, newest first",
                  })),
                ]}
                onSelect={(row) => {
                  const v = String(row.value)
                  if (v === "__scope__") return list(!onlySession)
                  const e = rows[Number(v.slice(2))]
                  if (e) detail(e, onlySession)
                }}
              />
            ))
          }
          const detail = (
            e: Parameters<typeof requestTrace>[0],
            onlySession: boolean,
          ) =>
            api.ui.dialog.replace(
              () => (
                <api.ui.DialogSelect
                  title="Request trace"
                  options={[
                    backRow("recent requests"),
                    ...requestTrace(e, nameOf).map((l, i) => ({
                      title: l.text,
                      value: `l:${i}`,
                      category: l.section,
                    })),
                  ]}
                  onSelect={(row) => {
                    if (String(row.value) === BACK) list(onlySession)
                  }}
                />
              ),
              escapeTo(() => list(onlySession)),
            )
          list(lastSessionId !== null)
        },
      },
      {
        name: "claude-auth.debug",
        title: paletteTitle("Diagnostics", "Explain routing"),
        category: "Claude Auth",
        namespace: "palette",
        slashName: "cc-debug",
        async run() {
          // Re-read everything from disk first, so the report describes the
          // state as it is rather than as this process last cached it.
          resetConfigCache()
          resetProbeBlocks()
          const cfg = getConfig()
          const list = refreshAccountsList()

          // A forced probe: the point of asking is usually that something
          // looks wrong, and a stale reading is the commonest reason.
          let probe = "not attempted"
          try {
            const r = await refreshQuotas(
              list
                .map((a) => ({
                  source: a.source,
                  accessToken: a.credentials?.accessToken ?? "",
                }))
                .filter((a) => a.accessToken),
              { maxAgeSeconds: 0 },
            )
            probe = `probed ${r.probed}, skipped ${r.skipped}, failed ${r.failed}`
          } catch (e) {
            probe = `failed: ${(e as Error).message}`
          }

          const quota = readQuotaCache()
          // Which references resolve to nothing is the fault that is invisible
          // everywhere else: the balancer drops them and says nothing.
          const unresolved: string[] = []
          for (const [name, preset] of Object.entries(cfg.presets)) {
            const refs = Array.isArray(preset.pools)
              ? preset.pools.flatMap((t) => t.accounts ?? [])
              : (preset.accounts ?? [])
            for (const ref of refs) {
              if (!cfg.groups[ref] && !resolveRef(ref, list))
                unresolved.push(`${name}: ${ref}`)
            }
          }

          const text = [
            debugReport({
              build: BUILD,
              selection: loadPersistedAccountSource() ?? "__auto__",
              accounts: list,
              quota,
              presets: cfg.presets,
              unresolved,
              config: {
                strategy: cfg.strategy,
                preset: cfg.preset ?? "(none)",
                useCredits: cfg.useCredits,
                switchAt: cfg.switchAt,
                switchWindow: cfg.switchWindow,
                autoSwitch: cfg.autoSwitch,
                bindBy: cfg.bindBy,
                quotaProbe: cfg.quotaProbe,
                quotaProbeMaxAge: cfg.quotaProbeMaxAge,
                accounts: cfg.accounts,
              },
            }),
            "",
            `probe      ${probe}`,
          ].join("\n")

          const out = dataFile("report.txt")
          try {
            writeFileSync(out, `${text}\n`, "utf8")
            api.ui.toast({
              variant: "success",
              title: "Report written",
              message: out,
            })
          } catch {
            api.ui.toast({
              variant: "error",
              title: "Could not write the report",
              message: out,
            })
          }

          // Shown as well as written: the file is for pasting, the dialog is
          // for the answer being one keypress away.
          api.ui.dialog.replace(() => (
            <api.ui.DialogSelect
              title={`Claude auth — ${out}`}
              options={text.split("\n").map((line, i) => ({
                title: line || " ",
                value: `l${i}`,
                description: "",
              }))}
            />
          ))
        },
      },
      {
        name: "claude-auth.optimize",
        title: paletteTitle("Optimize", "Ranked fixes"),
        category: "Claude Auth",
        namespace: "palette",
        slashName: "optimize",
        run() {
          const sid = lastSessionId
          if (!sid) {
            api.ui.toast({
              variant: "warning",
              message: "Open a session first, then run /optimize.",
            })
            return
          }
          sendOptimize(sid)
        },
      },
      {
        name: "claude-auth.tokens",
        title: paletteTitle("Usage", "Token usage"),
        category: "Claude Auth",
        namespace: "palette",
        slashName: "tokens",
        run() {
          const sid = lastSessionId
          if (!sid) {
            api.ui.toast({
              variant: "warning",
              message: "Open a session first, then run /tokens.",
            })
            return
          }
          openDetails(sid)
        },
      },
      {
        name: "claude-auth.stats",
        title: paletteTitle("Usage", "Usage by session"),
        category: "Claude Auth",
        namespace: "palette",
        slashName: "cc-stats",
        run() {
          const since = Date.now() - 24 * 60 * 60_000
          // Read once and reuse: this is the only file scan in the plugin, and
          // the detail view would otherwise repeat it on every selection.
          const events = readUsage(since)

          const openList = () => {
            const rows = sessionRows(summarizeSessions(events))
            api.ui.dialog.replace(() => (
              <api.ui.DialogSelect
                title={`Usage by session, last 24h (${rows.length})`}
                options={
                  rows.length > 0
                    ? rows
                    : [
                        {
                          title: "No requests recorded in the last 24h",
                          value: "",
                          description:
                            "Sessions appear here once the plugin has served a request for them.",
                        },
                      ]
                }
                onSelect={(row) => {
                  const id = String(row.value)
                  if (id) openDetail(id)
                }}
              />
            ))
          }

          const openDetail = (session: string) => {
            const detail = sessionDetail(events, session)
            if (!detail) return
            // Context comes from the capture file, which is empty unless
            // captureRequests is on. detailRows says so rather than showing an
            // empty section.
            let context = null
            try {
              context = contextSummary(
                readShapeFile().filter(
                  (sh: { sessionId: string | null }) =>
                    sh.sessionId === session,
                ),
              )
            } catch {
              context = null
            }
            const rows = detailRows(detail, {
              names: displayNames(),
              context,
            })
            api.ui.dialog.replace(() => (
              <api.ui.DialogSelect
                title={`Session ${session.slice(-8)}`}
                options={[backRow("the session list"), ...rows]}
                // Any row goes back: nothing here is selectable, and landing at
                // the prompt after reading one number is not where you were.
                onSelect={() => openList()}
              />
            ))
          }

          openList()
        },
      },
      {
        name: "claude-auth.presets",
        title: paletteTitle("Presets", "Edit presets"),
        category: "Claude Auth",
        namespace: "palette",
        slashName: "cc-presets",
        run() {
          // Presets live on the Manage accounts menu, under their own category:
          // a new preset, and each existing one with its accounts, knobs,
          // maxUsage and capMode. Rather than a second copy of ~400 lines of
          // editor, this opens that menu where the presets already are.
          const dispatch = (api.keymap as { dispatch?: (id: string) => void })
            .dispatch
          if (typeof dispatch === "function") dispatch("claude-auth.accounts")
          else
            api.ui.toast({
              variant: "info",
              title: "Presets",
              message: "Open Manage accounts; presets are edited there.",
            })
        },
      },
      {
        name: "claude-auth.cache",
        title: paletteTitle("Cache", "Review impact and settings"),
        category: "Claude Auth",
        namespace: "palette",
        slashName: "cc-cache",
        run() {
          // The request log carries the token counts the quota cache cannot:
          // reads, writes and uncached input per request. cacheViewRows totals
          // them per account and per session and labels each miss by cause.
          const requests = requestsFromUsage(
            readUsage(Date.now() - 24 * 60 * 60_000),
          )
          const editSetting = (key: string) => {
            const meta = EDITABLE.find((e) => e.key === key)
            if (!meta) return
            const current = (getConfig() as unknown as Record<string, unknown>)[
              key
            ]
            api.ui.dialog.replace(() => (
              <api.ui.DialogSelect
                title={`${meta.label} (${key})`}
                options={optionsFor(meta, current, getConfig().presets)}
                onSelect={(choice) => {
                  const checked = validateValue(meta, String(choice.value))
                  if (checked.ok) writeSetting(key, checked.literal)
                  showView()
                }}
              />
            ))
          }
          // The shape log carries no prefix hashes today, so the join is a no-op
          // and classification falls back to account/model/TTL signals.
          const showView = () => {
            const impact = optimizationRows(
              cacheImpact(toCacheRows(requests)),
              getConfig() as unknown as Record<string, unknown>,
            ).map((r, j) => ({
              title: r.label,
              description: r.value,
              value: r.setting ? `set:${r.setting}` : `impact:${j}`,
              category: "Impact (24h) \u00b7 select a setting to change it",
            }))
            const blocks = cacheBreakdownBlocks(
              cacheBreakdown(toCacheRows(requests)),
              {
                order: idOrder(),
                names: idNames(),
                ...(lastSessionId ? { session: lastSessionId } : {}),
              },
            )
            const options = [
              ...impact,
              ...blocks.flatMap((b) =>
                b.rows.map((r, j) => ({
                  title: r.label.trim(),
                  description: r.value,
                  value: `${b.title}:${j}`,
                  category: b.title,
                })),
              ),
            ]
            api.ui.dialog.replace(() => (
              <api.ui.DialogSelect
                title={paletteTitle("Cache", "Review impact and settings")}
                onSelect={(row) => {
                  const v = String(row.value)
                  if (v.startsWith("set:")) editSetting(v.slice(4))
                }}
                options={
                  options.length
                    ? options
                    : [
                        {
                          title: "No requests in the last 24h",
                          value: "",
                          description:
                            "cache figures appear once the plugin has served requests",
                        },
                      ]
                }
              />
            ))
          }
          showView()
        },
      },
      {
        name: "claude-auth.accounts",
        title: paletteTitle("Accounts", "Manage accounts"),
        category: "Claude Auth",
        namespace: "palette",
        slashName: "cc-accounts",
        run() {
          const configFile = candidatePaths()[0]!

          /**
           * One surgical write, then drop the config cache.
           *
           * Every screen here re-reads getConfig() when it opens, and that read
           * is served from a cache held for configReloadInterval -- so without
           * the reset the screen redraws showing what was there before.
           */
          const writeKey = (key: string, literal: string, note: string) => {
            try {
              const before = readFileSync(configFile, "utf8")
              const after = setJsoncValue(before, key, literal)
              if (!after) {
                api.ui.toast({
                  variant: "error",
                  title: "Not changed",
                  message: `Could not edit ${key} safely. The file was left alone.`,
                })
                return false
              }
              const tmp = `${configFile}.tmp-${process.pid}`
              writeFileSync(tmp, after, "utf8")
              renameSync(tmp, configFile)
              resetConfigCache()
              setSnap(read())
              api.ui.toast({ variant: "success", title: key, message: note })
              return true
            } catch (err) {
              api.ui.toast({
                variant: "error",
                title: "Write failed",
                message: err instanceof Error ? err.message : String(err),
              })
              return false
            }
          }

          // Accounts the config has no id mapping for yet, with a suggested id
          // each. An empty list means every account is already migrated.
          const unassigned = () => {
            const cfg = getConfig()
            const ids = readIdentityCache()
            return suggestIds(
              accounts.map((a) => a.source),
              ids,
              cfg.accountIds,
            ).filter((s) => accountKey(s.source) === s.source)
          }

          const menu = () => {
            const cfg = getConfig()
            const enabledCount = enabled().length
            const needIds = unassigned()
            api.ui.dialog.replace(() => (
              <api.ui.DialogSelect
                title="Claude accounts"
                options={[
                  {
                    title: `Accounts in use: ${enabledCount} of ${accounts.length}`,
                    value: "__accounts__",
                    description: "include or exclude an account",
                    category: "Accounts",
                  },
                  ...(needIds.length
                    ? [
                        {
                          title: `Assign IDs (suggested: ${needIds.map((s) => s.id).join(", ")})`,
                          value: "__migrate__",
                          description: `${needIds.length} account${needIds.length === 1 ? "" : "s"} without a stable id`,
                          category: "Accounts",
                        },
                      ]
                    : []),
                  {
                    title: "Re-read the Keychain",
                    value: "__refresh__",
                    description:
                      "pick up an account added or removed since this session started",
                    category: "Accounts",
                  },
                  {
                    title: "Refresh quota and credits now",
                    value: "__probe__",
                    description:
                      "ask every account for its usage, ignoring the freshness gate",
                    category: "Accounts",
                  },
                  ...Object.entries(cfg.groups).map(([id, g]) => ({
                    title: `${groupLabel(id, g)} (${g.accounts.length})`,
                    value: `g:${id}`,
                    description: `group id ${id}`,
                    category: "Groups",
                  })),
                  {
                    title: "New group",
                    value: "__newgroup__",
                    description: "a name; accounts are added next",
                    category: "Groups",
                  },
                  ...presetRows(cfg.presets, selectionOf()),
                  {
                    title: "New preset",
                    value: "__new__",
                    description: "a name, a strategy and a set of accounts",
                    category: "Presets",
                  },
                ]}
                onSelect={(row) => {
                  const v = String(row.value)
                  if (v === "__accounts__") openAccounts()
                  else if (v === "__migrate__") openMigration()
                  else if (v === "__probe__") {
                    // Past the freshness gate, not past the rate limit: the
                    // endpoint allows about one call an hour per account and
                    // refuses with a retry-after in the thousands of seconds.
                    // Asking harder does not make it answer.
                    resetProbeBlocks()
                    const targets = refreshAccountsList()
                      .map((a) => ({
                        source: a.source,
                        accessToken: a.credentials?.accessToken ?? "",
                      }))
                      .filter((a) => a.accessToken)
                    void refreshQuotas(targets, { maxAgeSeconds: 0 }).then(
                      (r) => {
                        setSnap(read())
                        api.ui.toast({
                          variant: r.probed > 0 ? "success" : "warning",
                          title: "Usage refreshed",
                          message:
                            r.probed > 0
                              ? `${r.probed} account(s) updated.`
                              : "Rate-limited — showing the last figures reported.",
                        })
                      },
                    )
                    menu()
                  } else if (v === "__refresh__") {
                    accounts = loadAccounts()
                    api.ui.toast({
                      variant: "success",
                      title: "Accounts",
                      message: `${accounts.length} found in the Keychain.`,
                    })
                    menu()
                  } else if (v === "__new__") newPreset()
                  else if (v === "__newgroup__") newGroup()
                  else if (v.startsWith("g:")) openGroup(v.slice(2))
                  else openPreset(v)
                }}
              />
            ))
          }

          /**
           * Preview the id rewrite, then apply it on confirm.
           *
           * applyMigration backs the file up and rewrites every reference, so it
           * is shown first — the list of source → id it is about to write — and
           * only run on a yes. pairFor reads the identity cache, which is where
           * the account/org uuids that an id binds to live.
           */
          const openMigration = () => {
            const ids = readIdentityCache()
            const suggestions = unassigned()
            const preview = migrationPreviewRows(suggestions, displayNames())
            api.ui.dialog.replace(
              () => (
                <api.ui.DialogSelect
                  title="Assign IDs — preview, enter to apply"
                  options={[
                    backRow("accounts"),
                    {
                      title: "Apply this rewrite",
                      value: "__apply__",
                      description:
                        "backs up the config, then rewrites every reference to use ids",
                      category: "Migration",
                    },
                    ...preview.map((r, i) => ({
                      title: r.label,
                      value: `p:${i}`,
                      description: r.value,
                      category: "Will assign",
                    })),
                  ]}
                  onSelect={(row) => {
                    const v = String(row.value)
                    if (v !== "__apply__") return menu()
                    const result = applyMigration(
                      candidatePaths()[0]!,
                      membersForMigration(
                        accounts,
                        ids,
                        getConfig().accountIds,
                      ),
                      (source: string) => {
                        const id = ids[source]
                        return id
                          ? { account: id.accountUuid, org: id.orgUuid }
                          : undefined
                      },
                    )
                    resetConfigCache()
                    setSnap(read())
                    api.ui.toast({
                      variant: result.migrated ? "success" : "warning",
                      title: "Assign IDs",
                      message: result.migrated
                        ? toastResult(
                            "IDs",
                            "assigned",
                            `backup ${(result.backupPath ?? "").split("/").pop() ?? "written"}`,
                          )
                        : toastResult(
                            "IDs",
                            "not assigned",
                            "nothing to rewrite, or the config could not be read",
                          ),
                    })
                    menu()
                  }}
                />
              ),
              escapeTo(menu),
            )
          }

          const selectionOf = () => {
            try {
              return readFileSync(dataFile("selection.txt"), "utf8").trim()
            } catch {
              return "__auto__"
            }
          }

          // The id-first caps row for one account: id, name, both windows'
          // used-vs-ceiling bars and whether it is reserved. The utilisation is
          // read from the quota cache the same way the chip reads it.
          const capRowOf = (a: { source: string; label: string }) => {
            const cfg = getConfig()
            const id = accountKey(a.source)
            const u = utilisationOf(a.source)
            const row = accountCapRow({
              id,
              name: displayNames().get(a.source) ?? a.source,
              enabled: enabled().includes(a.source),
              five: ceilingView(u.five, ceilingFor(cfg, id, "5h")),
              week: ceilingView(u.week, ceilingFor(cfg, id, "7d")),
              capMode: cfg.capMode,
            })
            return {
              title: row.label,
              value: a.source,
              description: row.value,
              category: "Accounts",
            }
          }

          const openAccounts = () => {
            api.ui.dialog.replace(() => (
              <api.ui.DialogSelect
                title="Accounts the balancer may use"
                options={[
                  backRow("accounts"),
                  ...[
                    ...visible(),
                    ...accounts.filter((a) => !enabled().includes(a.source)),
                  ].map(capRowOf),
                  ...accounts.map((a) => ({
                    title: `Ceilings for ${accountKey(a.source)}`,
                    value: `c:${a.source}`,
                    description: "reserve this account above a utilisation",
                    category: "Ceilings",
                  })),
                  ...accounts.map((a) => ({
                    title: `Rename ${displayNames().get(a.source) ?? a.source}`,
                    value: `r:${a.source}`,
                    description: a.label,
                    category: "Rename",
                  })),
                ]}
                onSelect={(row) => {
                  const rv = String(row.value)
                  if (rv === BACK) return menu()
                  if (rv.startsWith("c:")) return editCeiling(rv.slice(2))
                  if (rv.startsWith("r:")) return rename(rv.slice(2))
                  const next = toggleAccount(
                    accounts,
                    getConfig().accounts,
                    String(row.value),
                    refToSource,
                    accountKey,
                  )
                  if (!next) {
                    api.ui.toast({
                      variant: "error",
                      title: "Accounts",
                      message: toastResult(
                        "Account",
                        "not changed",
                        "at least one has to stay enabled",
                      ),
                    })
                    openAccounts()
                    return
                  }
                  writeKey(
                    "accounts",
                    JSON.stringify(next),
                    next.length === 0
                      ? "All accounts enabled."
                      : `${next.length} of ${accounts.length} enabled.`,
                  )
                  openAccounts()
                }}
              />
            ))
          }

          /**
           * Edit one account's ceilings, written to `accountIds.<id>.maxUsage`.
           *
           * A ceiling is per window; an empty value clears it (inherit = unset,
           * i.e. no ceiling). The id must exist in the registry before a ceiling
           * can hang off it — an un-migrated account is sent to Assign IDs first.
           */
          const editCeiling = (source: string) => {
            const id = accountKey(source)
            const cfg = getConfig()
            if (id === source || !cfg.accountIds[id]) {
              api.ui.toast({
                variant: "warning",
                title: "Ceilings",
                message: toastResult(
                  "Ceiling",
                  "not set",
                  "assign an id to this account first",
                ),
              })
              return openAccounts()
            }

            const askWindow = (window: "5h" | "7d") => {
              const currentCfg = getConfig()
              const cur = currentCfg.accountIds[id]?.maxUsage?.[window]
              askText(
                `${window} ceiling for ${id} (empty = none)`,
                cur === undefined ? "" : String(cur),
                (value: string) => {
                  const trimmed = value.trim()
                  const entry = {
                    ...currentCfg.accountIds[id],
                  } as {
                    match: unknown
                    name?: string
                    maxUsage?: Record<string, number>
                  }
                  const maxUsage = { ...entry.maxUsage }
                  if (trimmed === "") {
                    delete maxUsage[window]
                  } else {
                    const n = Number(
                      trimmed.endsWith("%")
                        ? Number(trimmed.slice(0, -1)) / 100
                        : trimmed,
                    )
                    if (!Number.isFinite(n) || n <= 0 || n > 1) {
                      api.ui.toast({
                        variant: "error",
                        title: "Ceilings",
                        message: toastResult(
                          "Ceiling",
                          "not set",
                          "a ratio above 0 and at most 1, e.g. 0.8 or 80%",
                        ),
                      })
                      return askWindow(window)
                    }
                    maxUsage[window] = n
                  }
                  if (Object.keys(maxUsage).length) entry.maxUsage = maxUsage
                  else delete entry.maxUsage
                  const nextIds = { ...currentCfg.accountIds, [id]: entry }
                  writeKey(
                    "accountIds",
                    indentJson(nextIds, 2),
                    toastResult(
                      `Ceiling ${window} for ${id}`,
                      trimmed === "" ? "cleared" : `set to ${trimmed}`,
                    ),
                  )
                  openCeiling()
                },
                () => openCeiling(),
                "0.8",
              )
            }

            const openCeiling = () => {
              const c = getConfig()
              const mu = c.accountIds[id]?.maxUsage
              api.ui.dialog.replace(
                () => (
                  <api.ui.DialogSelect
                    title={`Ceilings for ${id}`}
                    options={[
                      backRow("accounts"),
                      {
                        title: `5h ceiling: ${mu?.["5h"] === undefined ? "none" : `${Math.round(mu["5h"] * 100)}%`}`,
                        value: "5h",
                        description:
                          "reserve this account above this 5h utilisation",
                      },
                      {
                        title: `7d ceiling: ${mu?.["7d"] === undefined ? "none" : `${Math.round(mu["7d"] * 100)}%`}`,
                        value: "7d",
                        description:
                          "reserve this account above this weekly utilisation",
                      },
                    ]}
                    onSelect={(row) => {
                      const v = String(row.value)
                      if (v === BACK) return openAccounts()
                      askWindow(v as "5h" | "7d")
                    }}
                  />
                ),
                escapeTo(openAccounts),
              )
            }
            openCeiling()
          }

          const rename = (source: string) => {
            const cfg = getConfig()
            const current = displayNames().get(source) ?? ""
            const prompt = (seed: string) =>
              api.ui.dialog.replace(
                () => (
                  <api.ui.DialogPrompt
                    title="Name for this account"
                    placeholder="Team 1"
                    value={seed}
                    onConfirm={(value: string) => {
                      const name = value.trim()
                      const id = accountKey(source)
                      const entry = cfg.accountIds[id]
                      if (entry) {
                        const { name: _old, ...rest } = entry
                        writeKey(
                          "accountIds",
                          indentJson(
                            {
                              ...cfg.accountIds,
                              [id]: name === "" ? rest : { ...rest, name },
                            },
                            2,
                          ),
                          toastResult(
                            `Account ${id}`,
                            name === "" ? "name cleared" : "renamed",
                            name === ""
                              ? "derived name shown"
                              : `now "${name}"`,
                          ),
                        )
                        openAccounts()
                        return
                      }
                      const next = { ...cfg.accountNames }
                      // An empty name removes the override rather than storing
                      // one, so there is a way back to the derived name.
                      if (name === "") delete next[source]
                      else next[source] = name
                      writeKey(
                        "accountNames",
                        indentJson(next, 2),
                        name === "" ? "Name cleared." : `Now "${name}".`,
                      )
                      openAccounts()
                    }}
                    onCancel={() => openAccounts()}
                  />
                ),
                escapeTo(openAccounts),
              )
            prompt(current)
          }

          // Groups: keyed by a stable id, so renaming touches only the label
          // and every preset routing to the id keeps working.
          const saveGroups = (next: Record<string, unknown>, note: string) =>
            writeKey("groups", indentJson(next, 2), note)

          const newGroup = () =>
            askText(
              "Name for the new group",
              "",
              (value) => {
                const made = createGroup(getConfig().groups, value)
                if ("error" in made) {
                  api.ui.toast({
                    variant: "error",
                    title: "Group",
                    message: made.error,
                  })
                  return menu()
                }
                saveGroups(
                  made.groups,
                  `Group "${value.trim()}" created (id ${made.id}).`,
                )
                openGroup(made.id)
              },
              menu,
              "Main",
            )

          const openGroup = (id: string) => {
            const cfg = getConfig()
            const g = cfg.groups[id]
            if (!g) return menu()
            const inGroup = new Set(
              g.accounts.flatMap((r) => {
                const s = refToSource(r)
                return s ? [s] : []
              }),
            )
            const names = displayNames()
            api.ui.dialog.replace(
              () => (
                <api.ui.DialogSelect
                  title={`Group ${groupLabel(id, g)} (id ${id})`}
                  options={[
                    backRow("accounts"),
                    ...accounts.map((a) => ({
                      title: `${inGroup.has(a.source) ? "[x]" : "[ ]"} ${names.get(a.source) ?? a.source}`,
                      value: `m:${a.source}`,
                      description: accountKey(a.source),
                      category: "Members",
                    })),
                    {
                      title: "Rename",
                      value: "__rename__",
                      description: "changes the shown name; the id stays",
                      category: "Group",
                    },
                    {
                      title: "Delete",
                      value: "__delete__",
                      description: "presets naming it lose those accounts",
                      category: "Group",
                    },
                  ]}
                  onSelect={(row) => {
                    const v = String(row.value)
                    if (v === BACK) return menu()
                    if (v.startsWith("m:")) {
                      saveGroups(
                        toggleGroupMember(
                          getConfig().groups,
                          id,
                          v.slice(2),
                          refToSource,
                          accountKey,
                        ),
                        "Group updated.",
                      )
                      return openGroup(id)
                    }
                    if (v === "__rename__")
                      return askText(
                        "New name for the group",
                        groupLabel(id, g),
                        (value) => {
                          const next = renameGroup(
                            getConfig().groups,
                            id,
                            value,
                          )
                          if ("error" in next)
                            api.ui.toast({
                              variant: "error",
                              title: "Group",
                              message: next.error,
                            })
                          else
                            saveGroups(
                              next.groups,
                              `Renamed to "${value.trim()}".`,
                            )
                          openGroup(id)
                        },
                        () => openGroup(id),
                      )
                    if (v === "__delete__") {
                      const used = presetsUsingGroup(getConfig().presets, id)
                      return confirmThen(
                        `Delete group ${groupLabel(id, g)}?`,
                        used.length
                          ? `Presets ${used.join(", ")} name it and would lose its accounts.`
                          : "No preset names it.",
                        () => {
                          saveGroups(
                            deleteGroup(getConfig().groups, id),
                            "Group deleted.",
                          )
                          menu()
                        },
                        () => openGroup(id),
                      )
                    }
                  }}
                />
              ),
              escapeTo(menu),
            )
          }

          const savePresets = (next: Record<string, unknown>, note: string) =>
            // Indented so the block still reads as part of the file. Safe to
            // rewrite whole because a preset carries no comments inside it --
            // the explanatory comment sits above the key, outside the value.
            writeKey("presets", indentJson(next, 2), note)

          /**
           * The tiers of a failover preset, in the order they are tried.
           *
           * Reordering IS the edit that matters here -- which group serves
           * first -- so it gets the same + / - keys as the account order, for
           * the same reason: enter, a submenu and a direction is three steps
           * to nudge one row.
           */
          const openTiers = (
            name: string,
            preset: Record<string, unknown>,
            focus?: number,
          ) => {
            const pools = poolsOf(preset)
            let cursor = focus ?? -1

            const shift = (how: "up" | "down") => {
              if (cursor < 0) return
              const next = movePool(preset, cursor, how)
              if (!next) {
                api.ui.toast({
                  variant: "warning",
                  title: "Not moved",
                  message: `Already ${how === "up" ? "first" : "last"}.`,
                })
                return openTiers(name, preset, cursor)
              }
              savePresets({ ...getConfig().presets, [name]: next }, "")
              openTiers(name, next, how === "up" ? cursor - 1 : cursor + 1)
            }

            api.ui.dialog.replace(
              () => (
                <api.ui.DialogSelect
                  title={`${name} - ${pools.length} tiers, + or - to reorder`}
                  current={focus === undefined ? undefined : `p:${focus}`}
                  options={[
                    backRow(name),
                    ...poolRows(preset, displayNames(), accounts),
                    {
                      title: "Add a tier",
                      value: "__add__",
                      description: "a further fallback, tried after the rest",
                      category: "Tiers",
                    },
                  ]}
                  onMove={(row) => {
                    const v = String(row.value)
                    cursor = v.startsWith("p:") ? Number(v.slice(2)) : -1
                  }}
                  onFilter={(q) => {
                    const last = q.slice(-1)
                    if (last === "+") shift("up")
                    else if (last === "-") shift("down")
                  }}
                  onSelect={(row) => {
                    const v = String(row.value)
                    if (v === BACK) return menu()
                    if (v === "__add__") {
                      return askText(
                        "Name for the new tier",
                        "",
                        (value: string) => {
                          const next = addPool(
                            preset,
                            value.trim() || `tier ${pools.length + 1}`,
                          )
                          savePresets(
                            { ...getConfig().presets, [name]: next },
                            `${name}: tier added.`,
                          )
                          openTiers(name, next, pools.length)
                        },
                        () => openTiers(name, preset),
                      )
                    }
                    openTier(name, preset, Number(v.slice(2)))
                  }}
                />
              ),
              escapeTo(() => menu()),
            )
          }

          /** One tier: who is in it, what strategy it runs, and removal. */
          const openTier = (
            name: string,
            preset: Record<string, unknown>,
            index: number,
          ) => {
            const pool = poolsOf(preset)[index]
            if (!pool) return openTiers(name, preset)
            const names = displayNames()
            const { sources } = refsMembership(
              pool.accounts ?? [],
              accounts,
              getConfig().groups,
            )

            const save = (
              next: Record<string, unknown> | null,
              note: string,
            ) => {
              if (!next) {
                return api.ui.toast({
                  variant: "warning",
                  title: pool.name,
                  message:
                    "A tier keeps at least one account; delete it instead.",
                })
              }
              savePresets({ ...getConfig().presets, [name]: next }, note)
              openTier(name, next, index)
            }

            api.ui.dialog.replace(
              () => (
                <api.ui.DialogSelect
                  title={`${name} / ${pool.name || `tier ${index + 1}`}`}
                  options={[
                    { ...backRow(name), title: "← Back to the tiers" },
                    ...accounts.map((a) => ({
                      title: `${sources.has(a.source) ? "[x]" : "[ ]"} ${
                        names.get(a.source) ?? a.label ?? a.source
                      }`,
                      value: `a:${a.source}`,
                      description: sources.has(a.source)
                        ? "in this tier"
                        : "not in this tier",
                      category: "Accounts",
                    })),
                    {
                      title: `Strategy: ${pool.strategy ?? "inherited"}`,
                      value: "__strategy__",
                      description: pool.strategy
                        ? "set by this tier"
                        : "inherited from the preset",
                      category: "Tier",
                    },
                    {
                      title: "Rename this tier",
                      value: "__rename__",
                      description: pool.name || `tier ${index + 1}`,
                      category: "Tier",
                    },
                    {
                      title: "Delete this tier",
                      value: "__delete__",
                      description: "the accounts stay; only the grouping goes",
                      category: "Tier",
                    },
                  ]}
                  onSelect={(row) => {
                    const v = String(row.value)
                    if (v === BACK) return openTiers(name, preset, index)
                    if (v.startsWith("a:")) {
                      return save(
                        togglePoolAccount(
                          preset,
                          index,
                          v.slice(2),
                          accounts.map((x) => ({
                            ...x,
                            id: accountKey(x.source),
                          })),
                        ),
                        "",
                      )
                    }
                    if (v === "__rename__") {
                      return askText(
                        "New name for this tier",
                        pool.name ?? "",
                        (value: string) =>
                          save(
                            renamePool(
                              preset,
                              index,
                              value.trim() || pool.name,
                            ),
                            `${name}: tier renamed.`,
                          ),
                        () => openTier(name, preset, index),
                      )
                    }
                    if (v === "__delete__") {
                      return confirmThen(
                        `Delete tier ${pool.name || index + 1}?`,
                        "The accounts stay in the preset's other tiers only if they are also listed there.",
                        () => {
                          const next = removePool(preset, index)
                          if (!next) {
                            return api.ui.toast({
                              variant: "warning",
                              title: name,
                              message:
                                "The last tier cannot go; a preset with no tiers names nobody.",
                            })
                          }
                          savePresets(
                            { ...getConfig().presets, [name]: next },
                            `${name}: tier deleted.`,
                          )
                          openTiers(name, next)
                        },
                        () => openTier(name, preset, index),
                      )
                    }
                    // Strategy: the same list the preset knob offers, plus
                    // inheriting, so a tier is never stuck with one.
                    api.ui.dialog.replace(
                      () => (
                        <api.ui.DialogSelect
                          title={`Strategy for ${pool.name || `tier ${index + 1}`}`}
                          current={pool.strategy ?? "__inherit__"}
                          options={[
                            {
                              title: "Inherit from the preset",
                              value: "__inherit__",
                              description: "whatever the preset itself uses",
                            },
                            ...STRATEGY_NAMES.map((sname) => ({
                              title: sname,
                              value: sname,
                              description: "",
                            })),
                          ]}
                          onSelect={(pick) => {
                            const chosen = String(pick.value)
                            save(
                              setPoolStrategy(
                                preset,
                                index,
                                chosen === "__inherit__" ? null : chosen,
                              ),
                              `${name}: tier strategy set.`,
                            )
                          }}
                        />
                      ),
                      escapeTo(() => openTier(name, preset, index)),
                    )
                  }}
                />
              ),
              escapeTo(() => openTiers(name, preset, index)),
            )
          }

          const openPreset = (name: string) => {
            const cfg = getConfig()
            const preset = cfg.presets[name]
            if (!preset) return menu()
            if (!isFlat(preset)) return openTiers(name, preset)
            // A preset's accounts are references ("Acme 1"), not Keychain
            // sources, so membership has to be resolved the way the balancer
            // resolves it. Comparing against the source directly is what made
            // every box render empty in a preset that plainly had three.
            const { sources: inSet, unresolved } = presetMembership(
              preset,
              accounts,
              getConfig().groups,
            )
            const names = displayNames()
            api.ui.dialog.replace(() => (
              <api.ui.DialogSelect
                title={`${name} - ${preset.strategy ?? "sticky"}`}
                options={[
                  backRow("accounts"),
                  ...accounts.map((a) => ({
                    title: `${inSet.has(a.source) ? "[x]" : "[ ]"} ${names.get(a.source) ?? a.source}`,
                    value: `a:${a.source}`,
                    description: quotaText(readQuotaCache(), a.source, {
                      spend: true,
                    }),
                    category: "Accounts in this preset",
                  })),
                  ...unresolved.map((ref) => ({
                    // Shown rather than dropped: a reference matching nothing,
                    // or matching two and therefore refused, makes the preset
                    // quietly smaller than it reads.
                    title: `[?] ${ref}`,
                    value: `u:${ref}`,
                    description: "matches no account, or more than one",
                    category: "Accounts in this preset",
                  })),
                  ...knobRows(
                    preset,
                    cfg as unknown as Record<string, unknown>,
                    (key, v) =>
                      key === "weights" || key === "maxUsage"
                        ? `${Object.keys((v ?? {}) as object).length} set`
                        : display(v),
                  ),
                  {
                    title: "Delete this preset",
                    value: "__delete__",
                    description: "removes it from the config",
                    category: "Settings",
                  },
                ]}
                onSelect={(row) => {
                  const v = String(row.value)
                  if (v === BACK) return menu()
                  if (v.startsWith("u:")) {
                    // Drop a reference that resolves to nothing.
                    const ref = v.slice(2)
                    savePresets(
                      {
                        ...cfg.presets,
                        [name]: {
                          ...preset,
                          accounts: (preset.accounts ?? []).filter(
                            (r: string) => r !== ref,
                          ),
                        },
                      },
                      `Removed the reference ${ref}.`,
                    )
                    return openPreset(name)
                  }
                  if (v.startsWith("a:")) {
                    const next = togglePresetAccount(
                      preset,
                      v.slice(2),
                      accounts.map((x) => ({ ...x, id: accountKey(x.source) })),
                      getConfig().groups,
                    )
                    if (!next) {
                      api.ui.toast({
                        variant: "error",
                        title: "Not changed",
                        message: "A preset needs at least one account.",
                      })
                      return openPreset(name)
                    }
                    savePresets(
                      { ...cfg.presets, [name]: next },
                      `${(next.accounts ?? []).length} accounts in ${name}.`,
                    )
                    return openPreset(name)
                  }
                  if (v.startsWith("k:"))
                    return editKnob(name, preset, v.slice(2))
                  if (v === "__delete__") {
                    const doomed = cfg.presets[name]
                    const count = (doomed?.accounts ?? []).length
                    return confirmThen(
                      `Delete ${name}?`,
                      `Removes the preset, its ${count} account${count === 1 ? "" : "s"} and its strategy from the config. This cannot be undone from here.`,
                      () => {
                        const rest = { ...cfg.presets }
                        delete rest[name]
                        savePresets(rest, `${name} removed.`)
                        menu()
                      },
                      () => openPreset(name),
                    )
                  }
                }}
              />
            ))
          }

          /**
           * Edit one override, or clear it back to the default.
           *
           * Clearing is offered on every knob: without it a value set once can
           * only be changed and never returned to inheriting, so the preset
           * quietly stops tracking a default that later moves.
           */
          const editKnob = (
            name: string,
            preset: Record<string, unknown>,
            key: string,
          ) => {
            const defaults = getConfig() as unknown as Record<string, unknown>
            const save = (value: unknown) => {
              const next = { ...preset }
              if (value === undefined) delete next[key]
              else next[key] = value
              savePresets(
                { ...getConfig().presets, [name]: next },
                value === undefined
                  ? `${key} back to the default.`
                  : `${key} set for ${name}.`,
              )
              openPreset(name)
            }

            if (key === "weights") return editWeights(name, preset)
            if (key === "order") return editOrder(name, preset)
            if (key === "maxUsage") return editPresetCeilings(name, preset)

            const clearRow = {
              title: `Use the default (${display(defaults[key])})`,
              value: "__clear__",
              description: "stop overriding it here",
            }
            const choices =
              key === "strategy"
                ? STRATEGY_NAMES.map((v) => ({ title: v, value: v }))
                : key === "switchWindow"
                  ? ["5h", "7d", "binding"].map((v) => ({ title: v, value: v }))
                  : key === "capMode"
                    ? ["soft", "hard"].map((v) => ({ title: v, value: v }))
                    : key === "autoSwitch"
                      ? [
                          { title: "on", value: "true" },
                          { title: "off", value: "false" },
                        ]
                      : null

            if (choices) {
              return api.ui.dialog.replace(
                () => (
                  <api.ui.DialogSelect
                    title={`${key} for ${name}`}
                    options={[backRow(name), clearRow, ...choices]}
                    onSelect={(row) => {
                      const val = String(row.value)
                      if (val === BACK) return openPreset(name)
                      if (val === "__clear__") return save(undefined)
                      save(key === "autoSwitch" ? val === "true" : val)
                    }}
                  />
                ),
                escapeTo(() => openPreset(name)),
              )
            }

            // switchAt and ejectFor are typed, validated by the same rules the
            // settings editor uses rather than a second opinion about them.
            const meta = EDITABLE.find((e) => e.key === key)
            const prompt = (seed: string) =>
              api.ui.dialog.replace(
                () => (
                  <api.ui.DialogPrompt
                    title={`${key} for ${name} (empty = default)`}
                    placeholder={meta?.example}
                    value={seed}
                    onConfirm={(value: string) => {
                      if (value.trim() === "") return save(undefined)
                      const checked = meta
                        ? validateValue(meta, value)
                        : ({ ok: false, reason: "unknown setting" } as const)
                      if (!checked.ok) {
                        api.ui.toast({
                          variant: "error",
                          title: `${key} unchanged`,
                          message: checked.reason,
                        })
                        return prompt(value)
                      }
                      save(JSON.parse(checked.literal))
                    }}
                    onCancel={() => openPreset(name)}
                  />
                ),
                escapeTo(() => openPreset(name)),
              )
            prompt(preset[key] === undefined ? "" : String(preset[key]))
          }

          /**
           * Reorder a preset's accounts: priority tries them in this order,
           * round-robin cycles in it, the rest break ties with it.
           *
           * Two steps rather than one: a single tap that "moves up" cannot
           * express move-down or move-to-top, and guessing which one was meant
           * from a list position is how a reorder becomes a puzzle.
           */
          /**
           * Reorder the accounts `priority` reads.
           *
           * `focus` is the row the cursor should land on. Redrawing is how a
           * move is shown, and a fresh dialog starts at row 0 -- so without it
           * every move bounces the cursor to Back and the next + moves a
           * different account than the one just moved.
           */
          const editOrder = (
            name: string,
            preset: Record<string, unknown>,
            focus?: string,
          ) => {
            const list = (preset.accounts ?? []) as string[]
            const names = displayNames()

            // Empty while the cursor sits on a row that is not an account.
            // Defaulting to the first one made + reorder an account the cursor
            // was nowhere near, from the Back row.
            let cursor = focus ?? ""

            const shift = (how: "up" | "down") => {
              if (!cursor) return
              const next = moveRef(list, cursor, how)
              if (!next) {
                api.ui.toast({
                  variant: "warning",
                  title: "Not moved",
                  message: `Already ${how === "up" ? "first" : "last"}.`,
                })
                return editOrder(name, preset, cursor)
              }
              const body = { ...preset, accounts: next }
              savePresets({ ...getConfig().presets, [name]: body }, "")
              editOrder(name, body, cursor)
            }

            api.ui.dialog.replace(
              () => (
                <api.ui.DialogSelect
                  title={`Order for ${name} - type + or - to move, enter for more`}
                  current={focus ? `o:${focus}` : undefined}
                  options={[
                    backRow(name),
                    ...orderRows(list, names, (ref) =>
                      resolveRef(
                        ref,
                        accounts as { source: string; label?: string }[],
                      ),
                    ),
                  ]}
                  onMove={(row) => {
                    const v = String(row.value)
                    cursor = v.startsWith("o:") ? v.slice(2) : ""
                  }}
                  onFilter={(query) => {
                    // The only key hook this dialog offers; without it the
                    // filter box swallows the keystroke.
                    const last = query.slice(-1)
                    if (last === "+") shift("up")
                    else if (last === "-") shift("down")
                  }}
                  onSelect={(row) => {
                    const val = String(row.value)
                    if (val === BACK) return openPreset(name)
                    moveWhere(name, preset, val.slice(2))
                  }}
                />
              ),
              escapeTo(() => openPreset(name)),
            )
          }

          const moveWhere = (
            name: string,
            preset: Record<string, unknown>,
            ref: string,
          ) => {
            const list = (preset.accounts ?? []) as string[]
            const names = displayNames()
            const source = resolveRef(
              ref,
              accounts as { source: string; label?: string }[],
            )
            const label = (source && names.get(source)) ?? ref
            const apply = (how: "up" | "down" | "top" | "bottom") => {
              const next = moveRef(list, ref, how)
              if (!next) {
                // Refused rather than written: a no-op write still moves the
                // file's timestamp, and the timestamp is what every reader
                // watches.
                api.ui.toast({
                  variant: "warning",
                  title: "Not moved",
                  message: `${label} is already there.`,
                })
                return editOrder(name, preset, ref)
              }
              const body = { ...preset, accounts: next }
              savePresets(
                { ...getConfig().presets, [name]: body },
                `${label} is now #${next.indexOf(ref) + 1}.`,
              )
              editOrder(name, body, ref)
            }
            api.ui.dialog.replace(
              () => (
                <api.ui.DialogSelect
                  title={`Move ${label}`}
                  options={[
                    {
                      title: "\u2190 Back",
                      value: BACK,
                      description: "to the order",
                    },
                    {
                      title: "Up one",
                      value: "up",
                      description: "serve sooner",
                    },
                    {
                      title: "Down one",
                      value: "down",
                      description: "serve later",
                    },
                    {
                      title: "To the top",
                      value: "top",
                      description: "serve first",
                    },
                    {
                      title: "To the bottom",
                      value: "bottom",
                      description: "last resort",
                    },
                  ]}
                  onSelect={(row) => {
                    const val = String(row.value)
                    if (val === BACK) return editOrder(name, preset, ref)
                    apply(val as "up" | "down" | "top" | "bottom")
                  }}
                />
              ),
              escapeTo(() => editOrder(name, preset, ref)),
            )
          }

          /** Cycle each account's weight; 1 is the default and is not stored. */
          const editWeights = (
            name: string,
            preset: Record<string, unknown>,
          ) => {
            const weights = (preset.weights ?? {}) as Record<string, number>
            const names = displayNames()
            api.ui.dialog.replace(
              () => (
                <api.ui.DialogSelect
                  title={`Weights for ${name}`}
                  options={[
                    backRow(name),
                    ...accounts.map((a) => ({
                      title: `${names.get(a.source) ?? a.source}: ${weights[a.source] ?? 1}`,
                      value: `w:${a.source}`,
                      description:
                        weights[a.source] === undefined
                          ? "weighs 1 by default - select to cycle"
                          : "select to cycle 1 / 2 / 3 / 5",
                    })),
                  ]}
                  onSelect={(row) => {
                    const val = String(row.value)
                    if (val === BACK) return openPreset(name)
                    const src = val.slice(2)
                    const cycle = [1, 2, 3, 5]
                    const now = weights[src] ?? 1
                    const next =
                      cycle[(cycle.indexOf(now) + 1) % cycle.length] ?? 1
                    const updated: Record<string, number> = {
                      ...weights,
                      [src]: next,
                    }
                    // Storing the default weight adds a line the reader has to
                    // recognise as meaningless.
                    if (next === 1) delete updated[src]
                    const body: Record<string, unknown> = { ...preset }
                    if (Object.keys(updated).length) body.weights = updated
                    else delete body.weights
                    savePresets(
                      { ...getConfig().presets, [name]: body },
                      `${names.get(src) ?? src} weighs ${next}.`,
                    )
                    editWeights(name, body)
                  }}
                />
              ),
              escapeTo(() => openPreset(name)),
            )
          }

          /**
           * Per-account ceiling overrides for one preset, written to
           * `presets.<name>.maxUsage.<id>`. The id keys it, the same id the
           * global ceilings and the balancer use; an account with no stable id
           * cannot carry a per-preset ceiling, so it is skipped with a note.
           */
          const editPresetCeilings = (
            name: string,
            preset: Record<string, unknown>,
          ) => {
            const names = displayNames()
            const map = (preset.maxUsage ?? {}) as Record<
              string,
              { "5h"?: number; "7d"?: number }
            >
            const show = (id: string) => {
              const w = map[id]
              if (!w) return "inherited"
              const parts: string[] = []
              if (w["5h"] !== undefined)
                parts.push(`5h ${Math.round(w["5h"] * 100)}%`)
              if (w["7d"] !== undefined)
                parts.push(`wk ${Math.round(w["7d"] * 100)}%`)
              return parts.join(" · ") || "inherited"
            }
            const ask = (id: string, window: "5h" | "7d") => {
              const cur = map[id]?.[window]
              askText(
                `${window} ceiling for ${id} in ${name} (empty = inherit)`,
                cur === undefined ? "" : String(cur),
                (value: string) => {
                  const trimmed = value.trim()
                  const entry = { ...map[id] }
                  if (trimmed === "") {
                    delete entry[window]
                  } else {
                    const n = trimmed.endsWith("%")
                      ? Number(trimmed.slice(0, -1)) / 100
                      : Number(trimmed)
                    if (!Number.isFinite(n) || n <= 0 || n > 1) {
                      api.ui.toast({
                        variant: "error",
                        title: "Ceilings",
                        message: toastResult(
                          "Ceiling",
                          "not set",
                          "a ratio above 0 and at most 1",
                        ),
                      })
                      return perAccount()
                    }
                    entry[window] = n
                  }
                  const nextMap = { ...map }
                  if (Object.keys(entry).length) nextMap[id] = entry
                  else delete nextMap[id]
                  const body = { ...preset }
                  if (Object.keys(nextMap).length) body.maxUsage = nextMap
                  else delete body.maxUsage
                  savePresets(
                    { ...getConfig().presets, [name]: body },
                    toastResult(`Ceiling for ${id}`, "saved"),
                  )
                  editPresetCeilings(name, body)
                },
                () => perAccount(),
                "0.8",
              )
            }
            const perAccount = () =>
              api.ui.dialog.replace(
                () => (
                  <api.ui.DialogSelect
                    title={`Ceilings for ${name}`}
                    options={[
                      backRow(name),
                      ...accounts.flatMap((a) => {
                        const id = accountKey(a.source)
                        if (id === a.source) {
                          return [
                            {
                              title: `${names.get(a.source) ?? a.source}: no id`,
                              value: "",
                              description:
                                "assign an id before setting a ceiling",
                              category: "Accounts",
                            },
                          ]
                        }
                        return (["5h", "7d"] as const).map((w) => ({
                          title: `${id} ${w}: ${map[id]?.[w] === undefined ? "inherited" : `${Math.round(map[id]![w]! * 100)}%`}`,
                          value: `${id}|${w}`,
                          description: show(id),
                          category: `${names.get(a.source) ?? a.source}`,
                        }))
                      }),
                    ]}
                    onSelect={(row) => {
                      const v = String(row.value)
                      if (v === BACK) return openPreset(name)
                      if (!v.includes("|")) return perAccount()
                      const [id, w] = v.split("|")
                      ask(id!, w as "5h" | "7d")
                    }}
                  />
                ),
                escapeTo(() => openPreset(name)),
              )
            perAccount()
          }

          const newPreset = () => {
            const cfg = getConfig()
            const prompt = (seed: string) =>
              api.ui.dialog.replace(
                () => (
                  <api.ui.DialogPrompt
                    title="Name for the new preset"
                    placeholder="rr-13"
                    value={seed}
                    onConfirm={(value: string) => {
                      const checked = validatePresetName(value, cfg.presets)
                      if (!checked.ok) {
                        api.ui.toast({
                          variant: "error",
                          title: "Not created",
                          message: checked.reason,
                        })
                        return prompt(value)
                      }
                      // Starts from every enabled account: a preset of none
                      // cannot be saved, and this is the set already in use.
                      const seeded = {
                        label: checked.name,
                        strategy: "round-robin",
                        accounts: enabled().map(accountKey),
                      }
                      savePresets(
                        { ...cfg.presets, [checked.name]: seeded },
                        `${checked.name} created.`,
                      )
                      openPreset(checked.name)
                    }}
                    onCancel={() => menu()}
                  />
                ),
                escapeTo(menu),
              )
            prompt("")
          }

          accounts = loadAccounts()
          menu()
        },
      },
      {
        name: "claude-auth.config",
        title: paletteTitle("Settings", "Edit settings"),
        category: "Claude Auth",
        namespace: "palette",
        slashName: "cc-config",
        run() {
          const openList = () => {
            const cfg = getConfig() as unknown as Record<string, unknown>
            api.ui.dialog.replace(() => (
              <api.ui.DialogSelect
                title="Claude auth settings (no restart needed)"
                options={configRows(cfg)}
                onSelect={(row) => editKey(String(row.value))}
              />
            ))
          }

          const write = writeSetting

          const editKey = (key: string) => {
            const meta = EDITABLE.find((e) => e.key === key)
            if (!meta) return
            const cfg = getConfig() as unknown as Record<string, unknown>
            const current = cfg[key]

            // Only ratios and durations are typed; everything with a fixed
            // vocabulary is chosen, so a typo is not expressible there.
            if (meta.kind === "text") {
              // Free-form: no list to offer, and nothing to validate beyond
              // being a string. An EMPTY value is meaningful here rather than
              // a mistake -- it is how the relative style is asked for -- so
              // this deliberately skips validateValue.
              return askText(
                `${meta.label} (${key})`,
                current === undefined ? "" : String(current),
                (value: string) => {
                  write(key, toLiteral("text", value))
                  openList()
                },
                openList,
                meta.example,
              )
            }
            if (meta.kind === "number") {
              const prompt = (seed: string) =>
                api.ui.dialog.replace(
                  () => (
                    <api.ui.DialogPrompt
                      title={`${meta.label} (${key})`}
                      placeholder={meta.example}
                      value={seed}
                      onConfirm={(value: string) => {
                        const checked = validateValue(meta, value)
                        if (!checked.ok) {
                          // Refuse and stay put with what was typed, rather than
                          // writing a value the config layer would quietly
                          // replace with its default.
                          api.ui.toast({
                            variant: "error",
                            title: `${key} unchanged`,
                            message: checked.reason,
                          })
                          prompt(value)
                          return
                        }
                        write(key, checked.literal)
                        // Back to the list, not out to the prompt: changing one
                        // setting is rarely the whole errand, and dialog.clear()
                        // drops the entire stack.
                        openList()
                      }}
                      onCancel={() => openList()}
                    />
                  ),
                  escapeTo(openList),
                )
              prompt(current === undefined ? "" : String(current))
              return
            }

            api.ui.dialog.replace(() => (
              <api.ui.DialogSelect
                title={`${meta.label} (${key})`}
                options={[
                  backRow("settings"),
                  ...optionsFor(meta, current, getConfig().presets),
                ]}
                onSelect={(choice) => {
                  if (String(choice.value) === BACK) return openList()
                  const checked = validateValue(meta, String(choice.value))
                  if (checked.ok) write(key, checked.literal)
                  openList()
                }}
              />
            ))
          }

          openList()
        },
      },
    ],
    bindings: [
      { key: "<leader>a", cmd: "claude-auth.select", desc: "Switch account" },
      { key: "<leader>s", cmd: "claude-auth.stats", desc: "Usage by session" },
      { key: "<leader>c", cmd: "claude-auth.config", desc: "Edit settings" },
      {
        key: "<leader>A",
        cmd: "claude-auth.accounts",
        desc: "Manage accounts",
      },
    ],
  })
}

// One default export for both generations: V1 calls `tui`, V2 calls `setup`.
const plugin: TuiPluginModule & {
  id: string
  setup: (ctx: Parameters<typeof setupV2>[0]) => () => void
} = { id: "claude-auth.tui", tui, setup: (ctx) => setupV2(ctx, tui) }
export default plugin
