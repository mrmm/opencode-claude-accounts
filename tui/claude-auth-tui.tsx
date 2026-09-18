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
import { resolveRef } from "../dist/balance/index.js"
import {
  indentJson,
  isEditable,
  knobRows,
  moveRef,
  orderRows,
  presetMembership,
  presetRows,
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
import {
  configRows,
  display,
  EDITABLE,
  STRATEGY_NAMES,
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
  quotaText,
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
    shortNames(accounts, getConfig().accountNames, (ref, list) =>
      resolveRef(ref, list as { source: string; label?: string }[]),
    )

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
            names: displayNames(),
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
        name: "claude-auth.accounts",
        title: "Claude accounts in use",
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

          const menu = () => {
            const cfg = getConfig()
            const enabled = enabledSources(accounts, cfg.accounts).length
            api.ui.dialog.replace(() => (
              <api.ui.DialogSelect
                title="Claude accounts"
                options={[
                  {
                    title: `Accounts in use: ${enabled} of ${accounts.length}`,
                    value: "__accounts__",
                    description: "include or exclude an account",
                    category: "Accounts",
                  },
                  {
                    title: "Re-read the Keychain",
                    value: "__refresh__",
                    description:
                      "pick up an account added or removed since this session started",
                    category: "Accounts",
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
                  else if (v === "__refresh__") {
                    accounts = loadAccounts()
                    api.ui.toast({
                      variant: "success",
                      title: "Accounts",
                      message: `${accounts.length} found in the Keychain.`,
                    })
                    menu()
                  } else if (v === "__new__") newPreset()
                  else openPreset(v)
                }}
              />
            ))
          }

          const selectionOf = () => {
            try {
              return readFileSync(
                `${process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`}/opencode/claude-account-source.txt`,
                "utf8",
              ).trim()
            } catch {
              return "__auto__"
            }
          }

          const openAccounts = () => {
            const cfg = getConfig()
            api.ui.dialog.replace(() => (
              <api.ui.DialogSelect
                title="Accounts the balancer may use"
                options={[
                  backRow("accounts"),
                  ...accountToggleRows(
                    accounts,
                    cfg.accounts,
                    readQuotaCache(),
                    displayNames(),
                  ),
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
                  if (rv.startsWith("r:")) return rename(rv.slice(2))
                  const next = toggleAccount(
                    accounts,
                    getConfig().accounts,
                    String(row.value),
                  )
                  if (!next) {
                    api.ui.toast({
                      variant: "error",
                      title: "Not changed",
                      message: "At least one account has to stay enabled.",
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

          const savePresets = (next: Record<string, unknown>, note: string) =>
            // Indented so the block still reads as part of the file. Safe to
            // rewrite whole because a preset carries no comments inside it --
            // the explanatory comment sits above the key, outside the value.
            writeKey("presets", indentJson(next, 2), note)

          const openPreset = (name: string) => {
            const cfg = getConfig()
            const preset = cfg.presets[name]
            if (!preset) return menu()
            if (!isEditable(preset)) {
              api.ui.toast({
                variant: "warning",
                title: name,
                message: "Tiered presets are edited in the config file.",
              })
              return menu()
            }
            // A preset's accounts are references ("Acme 1"), not Keychain
            // sources, so membership has to be resolved the way the balancer
            // resolves it. Comparing against the source directly is what made
            // every box render empty in a preset that plainly had three.
            const { sources: inSet, unresolved } = presetMembership(
              preset,
              accounts,
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
                    description: quotaText(readQuotaCache(), a.source),
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
                      key === "weights"
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
                      accounts,
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
           * Reorder the accounts `priority` reads.
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
                        accounts: enabledSources(accounts, cfg.accounts),
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
