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
import { createSignal, onCleanup, Show } from "solid-js"

import {
  listAccounts,
  loadPersistedAccountSource,
  saveAccountSource,
} from "../dist/credentials.js"
import { readQuotaCache } from "../dist/balance/quota.js"
import { getConfig } from "../dist/config.js"
import {
  buildPickerOptions,
  formatChip,
  mostRecentlyObserved,
} from "../dist/tui/chip.js"

/** Two small file reads. No Keychain, no network, so polling is cheap. */
const POLL_MS = 4000

function read() {
  const quota = readQuotaCache()
  return {
    quota,
    selection: loadPersistedAccountSource() ?? "__auto__",
    activeSource: mostRecentlyObserved(quota),
  }
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  // Labels come from the Keychain, one subprocess per account. They do not
  // change while the TUI is open, so this is read once rather than per poll.
  let accounts: { source: string; label: string }[] = []
  try {
    accounts = listAccounts().map((a: { source: string; label: string }) => ({
      source: a.source,
      label: a.label,
    }))
  } catch {
    // Nothing readable: the chip renders nothing rather than an error string.
  }

  const [snap, setSnap] = createSignal(read())
  const timer = setInterval(() => setSnap(read()), POLL_MS)
  onCleanup(() => clearInterval(timer))

  api.slots.register({
    order: 200,
    slots: {
      session_prompt_right() {
        return (
          <Show when={accounts.length > 0}>
            <text fg={api.theme.current.textMuted}>
              {formatChip({ accounts, ...snap() })}
            </text>
          </Show>
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
    ],
    bindings: [
      { key: "<leader>a", cmd: "claude-auth.select", desc: "Claude account" },
    ],
  })
}

const plugin: TuiPluginModule & { id: string } = { id: "claude-auth.tui", tui }
export default plugin
