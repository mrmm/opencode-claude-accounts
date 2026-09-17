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
import { createSignal, For, onCleanup } from "solid-js"
import { readFileSync, renameSync, writeFileSync } from "node:fs"

import {
  loadPersistedAccountSource,
  refreshAccountsList,
  saveAccountSource,
} from "../dist/credentials.js"
import { readQuotaCache } from "../dist/balance/quota.js"
import { readShapeFile } from "../dist/introspect.js"
import {
  currentUsageIndex,
  readUsage,
  sessionDetail,
  summarizeSessions,
} from "../dist/balance/usage.js"
import { candidatePaths, getConfig, resetConfigCache } from "../dist/config.js"
import {
  configRows,
  EDITABLE,
  optionsFor,
  setJsoncValue,
  validateValue,
} from "../dist/config-edit.js"
import {
  buildPickerOptions,
  formatChip,
  mostRecentlyObserved,
  accountToggleRows,
  contextSummary,
  detailRows,
  enabledSources,
  sessionRows,
  shortNames,
  sidebarLines,
  toggleAccount,
} from "../dist/tui/chip.js"

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
  const visible = () =>
    (() => {
      const allowed = new Set(enabledSources(accounts, getConfig().accounts))
      return accounts.filter((a) => allowed.has(a.source))
    })()

  /**
   * Hue means load, and only load.
   *
   * "unknown" is muted rather than green: no reading is not good news, it is
   * an absence of news, and colouring it as healthy would claim something the
   * plugin does not know.
   */
  const healthColour = (h: "unknown" | "ok" | "warn" | "critical") =>
    h === "critical"
      ? api.theme.current.error
      : h === "warn"
        ? api.theme.current.warning
        : h === "ok"
          ? api.theme.current.success
          : api.theme.current.textMuted

  const [snap, setSnap] = createSignal(read())
  const timer = setInterval(() => setSnap(read()), POLL_MS)
  onCleanup(() => clearInterval(timer))

  api.slots.register({
    order: 200,
    slots: {
      session_prompt_right() {
        // No Show gate. Selection and quota come from files and are useful
        // even when the Keychain gives no labels; gating on labels is exactly
        // what made this render as nothing.
        return (
          <text fg={api.theme.current.textMuted}>
            {formatChip({ accounts: visible(), ...snap() })}
          </text>
        )
      },
    },
  })

  api.slots.register({
    order: 210,
    slots: {
      sidebar_content() {
        const view = () =>
          sidebarLines({
            accounts: visible(),
            hiddenCount: accounts.length - visible().length,
            thresholds: {
              warnAt: getConfig().quotaWarnAt,
              weeklyWarnAt: getConfig().quotaWeeklyWarnAt,
            },
            ...snap(),
          })
        return (
          <box>
            <text fg={api.theme.current.text}>
              <b>Claude Auth</b>
              <span style={{ fg: api.theme.current.textMuted }}>
                {" "}
                ({view().heading})
              </span>
            </text>
            <For each={view().rows}>
              {(row) => (
                <box flexDirection="row" gap={1}>
                  <text flexShrink={0} style={{ fg: healthColour(row.health) }}>
                    {row.active ? "\u25cf" : "\u00b7"}
                  </text>
                  <text
                    style={{
                      // Brightness says which account is serving; hue says how
                      // it is doing. Two facts, two channels -- the previous
                      // rendering put both on hue and could show neither.
                      fg: row.active
                        ? api.theme.current.text
                        : api.theme.current.textMuted,
                    }}
                  >
                    {row.name}
                    <span style={{ fg: healthColour(row.health) }}>
                      {"  "}
                      {row.detail}
                    </span>
                  </text>
                </box>
              )}
            </For>
          </box>
        )
      },
    },
  })

  api.keymap.registerLayer({
    commands: [
      {
        name: "claude-auth.select",
        title: "Claude account",
        category: "Claude Auth",
        namespace: "palette",
        slashName: "cc-account",
        run() {
          // Notice an account added since start-up, the way the switcher does.
          accounts = loadAccounts()
          const current = snap()
          const options = buildPickerOptions({
            accounts: visible(),
            presets: getConfig().presets,
            quota: current.quota,
            selection: current.selection,
          })
          // `dialog` is a stack: `replace` pushes this dialog, `clear` closes
          // it. There is no open()/close() pair.
          api.ui.dialog.replace(() => (
            <api.ui.DialogSelect
              title="Claude account"
              current={current.selection}
              options={options}
              onSelect={(option) => {
                // The whole point: one file write. No authorize(), no auth.json
                // rewrite, no provider rebuild. The next request routes to it.
                saveAccountSource(String(option.value))
                setSnap(read())
                api.ui.dialog.clear()
              }}
            />
          ))
        },
      },
      {
        name: "claude-auth.stats",
        title: "Claude usage by session",
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
              names: shortNames(accounts),
              context,
            })
            api.ui.dialog.replace(() => (
              <api.ui.DialogSelect
                title={`Session ${session.slice(-8)}`}
                options={rows}
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
        name: "claude-auth.accounts",
        title: "Claude accounts in use",
        category: "Claude Auth",
        namespace: "palette",
        slashName: "cc-accounts",
        run() {
          const configFile = candidatePaths()[0]!

          const open = () => {
            const cfg = getConfig()
            api.ui.dialog.replace(() => (
              <api.ui.DialogSelect
                title="Accounts the balancer may use"
                options={accountToggleRows(
                  accounts,
                  cfg.accounts,
                  readQuotaCache(),
                )}
                onSelect={(row) => flip(String(row.value))}
              />
            ))
          }

          const flip = (source: string) => {
            const next = toggleAccount(accounts, getConfig().accounts, source)
            if (!next) {
              // Refused rather than obeyed: an empty allow-list means "all", so
              // disabling the last account would re-enable every one of them.
              api.ui.toast({
                variant: "error",
                title: "Not changed",
                message: "At least one account has to stay enabled.",
              })
              open()
              return
            }
            try {
              const before = readFileSync(configFile, "utf8")
              const after = setJsoncValue(
                before,
                "accounts",
                JSON.stringify(next),
              )
              if (!after) {
                api.ui.toast({
                  variant: "error",
                  title: "Not changed",
                  message: "Could not edit accounts safely.",
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
                title: "Accounts",
                message:
                  next.length === 0
                    ? "All accounts enabled."
                    : `${next.length} of ${accounts.length} enabled.`,
              })
              setSnap(read())
              open()
            } catch (err) {
              api.ui.toast({
                variant: "error",
                title: "Write failed",
                message: err instanceof Error ? err.message : String(err),
              })
            }
          }

          accounts = loadAccounts()
          open()
        },
      },
      {
        name: "claude-auth.config",
        title: "Claude auth settings",
        category: "Claude Auth",
        namespace: "palette",
        slashName: "cc-config",
        run() {
          const configFile = candidatePaths()[0]!

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

          // Surgical write: this file is JSONC and its comments are the only
          // documentation at the point of use, so a parse-and-serialise round
          // trip would delete every one. Temp file then rename, so a crash
          // cannot leave half a config where a whole one was.
          const write = (key: string, literal: string) => {
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

          const editKey = (key: string) => {
            const meta = EDITABLE.find((e) => e.key === key)
            if (!meta) return
            const cfg = getConfig() as unknown as Record<string, unknown>
            const current = cfg[key]

            // Only ratios and durations are typed; everything with a fixed
            // vocabulary is chosen, so a typo is not expressible there.
            if (meta.kind === "number") {
              const prompt = (seed: string) =>
                api.ui.dialog.replace(() => (
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
                ))
              prompt(current === undefined ? "" : String(current))
              return
            }

            api.ui.dialog.replace(() => (
              <api.ui.DialogSelect
                title={`${meta.label} (${key})`}
                options={optionsFor(meta, current, getConfig().presets)}
                onSelect={(choice) => {
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
      { key: "<leader>a", cmd: "claude-auth.select", desc: "Claude account" },
      { key: "<leader>s", cmd: "claude-auth.stats", desc: "Claude usage" },
      { key: "<leader>c", cmd: "claude-auth.config", desc: "Claude settings" },
      {
        key: "<leader>A",
        cmd: "claude-auth.accounts",
        desc: "Claude accounts in use",
      },
    ],
  })
}

const plugin: TuiPluginModule & { id: string } = { id: "claude-auth.tui", tui }
export default plugin
