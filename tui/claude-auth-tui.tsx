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
import {
  currentUsageIndex,
  readUsage,
  summarizeSessions,
} from "../dist/balance/usage.js"
import { candidatePaths, getConfig } from "../dist/config.js"
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
  sessionRows,
  sidebarLines,
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
            {formatChip({ accounts, ...snap() })}
          </text>
        )
      },
    },
  })

  api.slots.register({
    order: 210,
    slots: {
      sidebar_content() {
        const view = () => sidebarLines({ accounts, ...snap() })
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
                  <text
                    flexShrink={0}
                    style={{
                      fg: row.rejected
                        ? api.theme.current.error
                        : row.active
                          ? api.theme.current.success
                          : api.theme.current.textMuted,
                    }}
                  >
                    {row.active ? "*" : "\u00b7"}
                  </text>
                  <text
                    style={{
                      fg: row.active
                        ? api.theme.current.text
                        : api.theme.current.textMuted,
                    }}
                  >
                    {row.name}
                    <span style={{ fg: api.theme.current.textMuted }}>
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
            accounts,
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
          // Read the log here rather than on the poll: this is a scan of the
          // telemetry file, which is the one thing in this plugin too expensive
          // to do every few seconds.
          const since = Date.now() - 24 * 60 * 60_000
          const rows = sessionRows(summarizeSessions(readUsage(since)))
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
              onSelect={() => api.ui.dialog.clear()}
            />
          ))
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
                    title={`${key} - ${meta.hint}`}
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
                      api.ui.dialog.clear()
                    }}
                    onCancel={() => openList()}
                  />
                ))
              prompt(current === undefined ? "" : String(current))
              return
            }

            api.ui.dialog.replace(() => (
              <api.ui.DialogSelect
                title={`${key} - ${meta.hint}`}
                options={optionsFor(meta, current, getConfig().presets)}
                onSelect={(choice) => {
                  const checked = validateValue(meta, String(choice.value))
                  if (checked.ok) write(key, checked.literal)
                  api.ui.dialog.clear()
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
    ],
  })
}

const plugin: TuiPluginModule & { id: string } = { id: "claude-auth.tui", tui }
export default plugin
