# opencode-claude-accounts

[![npm](https://img.shields.io/npm/v/opencode-claude-auth)](https://www.npmjs.com/package/opencode-claude-auth)
[![CI](https://github.com/griffinmartin/opencode-claude-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/griffinmartin/opencode-claude-auth/actions/workflows/ci.yml)
[![Socket Badge](https://socket.dev/api/badge/npm/package/opencode-claude-auth)](https://socket.dev/npm/package/opencode-claude-auth)

Self-contained Anthropic auth provider for OpenCode using your Claude Code credentials — no separate login or API key needed.

## How it works

The plugin registers its own auth provider with a custom fetch handler that intercepts all Anthropic API requests. It reads OAuth tokens from the macOS Keychain (or `~/.claude/.credentials.json` — or `$CLAUDE_CONFIG_DIR/.credentials.json` if that env var is set — on other platforms), caches them in memory with a 30-second TTL, and handles the full request lifecycle — no builtin Anthropic auth plugin required. On macOS, multiple Claude Code accounts are detected automatically and can be switched via `opencode auth login`.

It also syncs credentials to OpenCode's `auth.json` as a fallback (on Windows, it writes to both `%USERPROFILE%\.local\share\opencode\auth.json` and `%LOCALAPPDATA%\opencode\auth.json` to cover all installation methods). If a token is near expiry, it refreshes directly via Anthropic's OAuth endpoint (zero LLM tokens consumed), falling back to the Claude CLI if the direct refresh fails. Background re-sync runs every 5 minutes.

## Prerequisites

- Claude Code installed and authenticated (run `claude` at least once)
- OpenCode installed

macOS is preferred (uses Keychain). Linux and Windows work via the credentials file fallback.

## Installation

**For Humans**

**Option A: Let an LLM do it**

Paste this into any LLM agent (Claude Code, OpenCode, Cursor, etc.):

```
Install the opencode-claude-auth plugin and configure it by following: https://raw.githubusercontent.com/griffinmartin/opencode-claude-auth/main/installation.md
```

**Option B: Manual setup**

1. **Add the plugin** to `~/.config/opencode/opencode.json`:

   ```json
   {
     "plugin": ["opencode-claude-auth@latest"]
   }
   ```

   > The `@latest` tag ensures OpenCode always pulls the newest version on startup. No manual `npm install` is needed — OpenCode [automatically installs npm plugins using Bun at startup](https://opencode.ai/docs/plugins/#how-plugins-are-installed).

2. **Use it** — just run OpenCode. The plugin handles auth automatically using your Claude Code credentials.

**For LLM Agents**

See [installation.md](installation.md) for step-by-step agent instructions.

## Usage

Just run OpenCode. The plugin handles auth automatically — it reads your Claude Code credentials, provides them to the Anthropic API, and refreshes them in the background. If your credentials aren't OAuth-based, the plugin falls through to standard API key auth.

## Supported models

13 supported models. Run `pnpm run test:models` to verify against your account.

| Model                      |
| -------------------------- |
| claude-fable-5             |
| claude-haiku-4-5           |
| claude-haiku-4-5-20251001  |
| claude-opus-4-5            |
| claude-opus-4-5-20251101   |
| claude-opus-4-6            |
| claude-opus-4-7            |
| claude-opus-4-8            |
| claude-opus-5              |
| claude-sonnet-4-5          |
| claude-sonnet-4-5-20250929 |
| claude-sonnet-4-6          |
| claude-sonnet-5            |

## Credential sources

The plugin checks these in order:

1. macOS Keychain (all `Claude Code-credentials*` entries — multiple accounts are detected automatically)
2. `~/.claude/.credentials.json` (fallback, works on all platforms; if `CLAUDE_CONFIG_DIR` is set, reads `$CLAUDE_CONFIG_DIR/.credentials.json` instead)

## Multiple accounts (macOS)

If you have [multiple Claude Code accounts](https://gist.github.com/KMJ-007/0979814968722051620461ab2aa01bf2) authenticated on macOS, the plugin detects all of them from the Keychain automatically. Each account is labeled by its subscription tier (Claude Pro, Claude Max, etc.).

To switch accounts:

```bash
opencode auth login
```

Select "Switch Claude Code account" and pick the account you want to use. Your selection is persisted across sessions.

If only one account is found, the switcher is hidden and the plugin uses it directly.

## Balancing across accounts

The switcher's first row is **Auto — balance across accounts**. Pick it and the
plugin chooses the account itself, moving off one when it runs out of quota.
Pick a named account instead and that choice is pinned and persisted, exactly as
before.

Switching is hot. The access token is resolved per request, so a move takes
effect on the very next call — no provider reload, no OpenCode restart. Nothing
rotates until you turn it on:

```jsonc
{
  "autoSwitch": true, // off by default
  "switchAt": 0.95, // abandon an account at this utilisation
  "switchWindow": "binding", // "5h" | "7d" | "binding" (whichever is closer to its limit)
  "switchOn429": true, // also move when Anthropic actually refuses
  "strategy": "sticky",
}
```

### Strategies

| Strategy       | Chooses                                          |
| -------------- | ------------------------------------------------ |
| `sticky`       | the current account until it is spent (default)  |
| `priority`     | the first listed that is usable                  |
| `least-loaded` | whichever has the most quota headroom            |
| `least-used`   | whichever has served fewest requests (usage log) |
| `round-robin`  | the next one each time, in listed order          |
| `weighted`     | by `weights`, interleaved (smooth weighted RR)   |
| `random`       | uniform choice                                   |
| `p2c`          | samples two at random, keeps the emptier         |

`least-loaded` reads Anthropic's view of consumption; `least-used` reads ours.
They differ usefully: utilisation is weighted by how expensive each request was
and a request count is not, so one spreads spend and the other spreads turns.
`p2c` avoids the herd effect when several OpenCode windows decide independently
and would otherwise all pile onto whichever account currently looks emptiest.

**List order is priority order.** `priority` takes the first usable account,
`round-robin` walks them in that order, and ties break that way throughout.

The rotating strategies keep their cursor **per process**, so a series of short
`opencode run` invocations each start at the first account; spreading happens
across the requests within one session.

`sticky` is the default on purpose: Anthropic's prompt cache is **per account**,
so every move starts the new account's cache cold. The rotating strategies
spread load at the cost of cache hits — worth it when headroom matters more than
latency and input-token spend, and a bad trade otherwise.

### Pools and fallback

Pools are failover tiers, tried in order. A tier is only reached when every
account above it is spent, so "balance across these two, fall back to that one"
is:

```jsonc
{
  "autoSwitch": true,
  "pools": [
    {
      "name": "primary",
      "strategy": "least-loaded",
      "accounts": [
        "Claude Code-credentials-aaaa1111",
        "Claude Code-credentials-bbbb2222",
      ],
    },
    { "name": "reserve", "accounts": ["Claude Code-credentials"] },
  ],
}
```

A pool may override `strategy` and set per-account `weights`. Omit `pools`
entirely and every account forms one tier; set `accounts` instead to use a
subset, in preference order. Account names are Keychain sources — the values
`opencode auth login` shows, listable with
`security dump-keychain | grep 'Claude Code'`.

### Switching without interrupting the agent

Rotation is invisible to the agent by construction: the access token is resolved
per request inside the plugin's own `fetch`, so changing the active account
changes who serves the next call. Nothing is re-registered, no request is
cancelled, and neither the agent nor its subagents observe anything.

Choosing an account **through `opencode auth login` is different**, and is the
wrong door while work is in flight. Selecting there runs the auth hook's
`authorize()`; OpenCode re-initialises the provider, and anything running —
subagents included — is cancelled. Use the switcher when idle.

To change the selection mid-task, write the selection instead:

```bash
pnpm lb                 # what is selected, which presets and accounts exist
pnpm lb rr-12           # use a preset
pnpm lb "Team B"      # pin one account (label fragment or exact source)
pnpm lb auto            # balance, no pin
pnpm lb clear           # forget it; the config decides again
```

A running OpenCode re-reads the selection on its next request. Editing
`"preset"` in `claude-auth.jsonc` has the same effect, picked up within
`configReloadInterval`.

`autoSwitch` governs only whether the plugin moves on its **own** initiative
(threshold or refusal). An explicit selection is obeyed either way — otherwise
choosing a preset with `autoSwitch: false` would appear to do nothing.

### Tools

The plugin registers three tools, so the same surfaces are reachable from inside
a session:

| Tool                 | Does                                                                             |
| -------------------- | -------------------------------------------------------------------------------- |
| `claude_auth_status` | who is serving now, what is selected, and each account's verdict with the reason |
| `claude_auth_select` | switch to a preset, an account, `auto`, or `clear`                               |
| `claude_auth_usage`  | per-account requests, share, refusals, latency, rotations                        |

They register through the plugin's own `tool` hook rather than a separate MCP
server: an MCP server would be another process with its own lifecycle and its
own entry in `opencode.jsonc`, exposing functions that already live in this
process and read this plugin's state.

`claude_auth_select` is transparent in the way that matters — it writes the
selection file, so nothing is re-registered and nothing in flight is cancelled.

They are not free. Every description sits in the model's context for the whole
session, and the agent can call them, which means it can move accounts on its
own. `"tools": false` turns the set off and leaves the CLI.

### Per-session accounts

Subagents arrive as their own OpenCode sessions, so binding an account per
session lets N parallel subagents run on N accounts instead of queueing against
one subscription — and each session keeps its account, so the per-account prompt
cache stays warm rather than following a global rotation.

```jsonc
"bindBy": "session"   // or "none" for one account per process
```

A session keeps its account while that account is usable and moves only when its
own is spent; other sessions are untouched. The binding is per process and not
persisted — a session id means nothing in a later one. Mechanically, the session
id travels from `chat.headers` to the plugin's `fetch` on an internal header
which is stripped before the request leaves, and that session's token is resolved
against its own account, never by mutating the globally active one — doing that
would let concurrent sessions hand each other the wrong token.

### Pins

Selecting one specific account is a pin, and a pin is honoured: the balancer will
not move off it on threshold or refusal.

```jsonc
"pinBlocksRotation": true
```

Choosing something else still applies immediately. Set `false` to make a pin only
a starting point. Note that only an _explicit_ choice creates a pin — provider
auth running with no selection no longer records one, because doing so silently
froze the balancer on a rate-limited account.

### Presets

A preset is a named arrangement — which accounts, in what order, under which
strategy — offered as a row in `opencode auth login` above the individual
accounts. Selecting one is remembered, and beats `preset` in the config.

```jsonc
"presets": {
  "rr-12": {
    "label": "LB round-robin Team 1,2",
    "strategy": "round-robin",
    "accounts": ["Team A", "Team B"]
  },
  "tiered": {
    "label": "Team 1+2, fall back to Team 3",
    "pools": [
      { "name": "primary", "strategy": "least-loaded", "accounts": ["Team A", "Team B"] },
      { "name": "reserve", "accounts": ["Team C"] }
    ]
  }
},
"preset": ""
```

An account is named either by its exact Keychain source or by any **unique
fragment of its label**, which is why the above reads `Team B` rather than
`Claude Code-credentials-bbbb2222`. A fragment matching more than one account is
refused rather than guessed. A preset declares either `accounts` or `pools`,
never both, so the effective set never depends on settings the preset did not
mention. An unknown preset name is ignored rather than fatal — a typo must not
silently narrow which accounts may serve requests.

`CLAUDE_AUTH_PRESET=<name>` selects one for a single run.

### Usage telemetry

Every response is recorded — which account served it, the model, status,
duration, and the utilisation the headers reported — to
`~/.local/share/opencode/claude-auth-usage.jsonl`, along with every rotation.
The quota cache holds only the newest reading per account, so it answers "how
full is this account" but never "how much has it served, and how often was it
refused".

```
pnpm usage            # last 24h
pnpm usage -- 7d      # last 7 days
pnpm usage -- 1h --json
```

```
account                               reqs    share    429    err       avg     quota  last used
Claude Code-credentials-cccc3333         4      40%      0      0     835ms        0%  3m ago
Claude Code-credentials-aaaa1111         3      30%      0      0     718ms       97%  12s ago
Claude Code-credentials-bbbb2222         3      30%      0      0    1007ms        2%  9s ago

rotations: 11
  startup: 5
  quota-observed: 6
```

Storage is append-only JSONL rather than SQLite, unlike the token-optimizer
plugin: this plugin has no runtime dependencies and keeps none, and it is loaded
by OpenCode, which ships as a Bun binary, while its own tests run under
`node --test`. A native SQLite module risks failing to load in the first, and
`bun:sqlite` does not exist in the second. The file is capped and rolls over to
`.1`; `least-used` reads it through a 30s cache so telemetry never costs more
than the thing it measures.

### What is in the prompt

Every request carries a system prompt, a tool schema for each registered tool,
and the conversation. The first two are paid on every turn regardless of what
you type, and they are invisible — `captureRequests` records them so they can be
measured.

```jsonc
{ "captureRequests": "shape" } // off | shape | full | messages
```

| level      | records                                                                                |
| ---------- | -------------------------------------------------------------------------------------- |
| `off`      | nothing. The default.                                                                  |
| `shape`    | sizes, hashes and an 80-character head. No text.                                       |
| `full`     | the above plus the system text, so a block can be traced to the file that produced it. |
| `messages` | the above plus **the conversation itself, verbatim on disk**.                          |

Records land in `~/.local/share/opencode/claude-auth-requests.jsonl`. Then:

```bash
pnpm prompt              # the most recent request
pnpm prompt -- --all     # aggregated across every captured request
```

The report breaks the system prompt into blocks, largest first, with the file
each one came from; lists the per-tool schema cost with descriptions broken out;
and separates fixed overhead from conversation, noting how much is cacheable.

`shape` and `full` never record message content — two tests assert a known
string cannot appear in the output at either level. `messages` exists for the
times that is the actual question ("what is being sent?"), and it writes your
conversation to a plain-text file. It is hot-reloadable like every other
setting, so the intended use is to turn it on in the config file, reproduce the
one thing you need to see, and turn it straight back off. Nothing enables it for
you, and no other level implies it.

Blocks composed programmatically by OpenCode report as `unattributed`, which is
the useful answer: no file is responsible for them.

### Assistant prefill refusals

Some models answer 400 `This model does not support assistant message prefill.
The conversation must end with a user message.` OpenCode sends a trailing
assistant message when a turn was interrupted, so the next request inherits it
and the session wedges: each retry rebuilds the same body and fails identically.

```jsonc
{ "retryPrefillError": true }
```

Once enabled, that specific 400 -- and no other -- triggers one retry with the
trailing assistant turn removed. Off by default because it is lossy: the partial
turn the model was being asked to continue is dropped. On a model that refuses
prefill that turn cannot be sent at all, so the choice is between losing it and
a session that cannot proceed.

Every outcome is logged, because the request that succeeded is not the request
the session composed and nothing else says so:

| event                   | level | meaning                                                                          |
| ----------------------- | ----- | -------------------------------------------------------------------------------- |
| `prefill_detected`      | warn  | the 400 was seen and matched                                                     |
| `prefill_recovered`     | warn  | retried without the trailing turn and it worked; carries `droppedAssistantTurns` |
| `prefill_retry_failed`  | error | retried and the model still refused; carries the new status                      |
| `prefill_retry_skipped` | error | nothing safe to strip, with the reason                                           |

A recovery also raises a toast, for the same reason a silent account switch
does: it changes what was sent.

It refuses to act when there is nothing safe to do: a body it cannot parse, one
that does not actually end with an assistant turn, or one that is _only_
assistant turns, where stripping would send an empty conversation and trade a
clear error for a baffling one. Those cases log `prefill_retry_skipped` rather
than failing quietly.

### When an account is spent

Health is derived from the rate-limit headers Anthropic returns on every
response, so nothing extra is stored and nothing expires by guesswork: an
account is spent when `utilization >= switchAt` or the server says `rejected`,
and it is healthy again once the window's own reset time passes. A refusal that
arrives without a reset time gets a bounded ejection instead, backing off on
each consecutive failure (`ejectFor`, default 5m).

When every account in every tier is spent, the plugin stays put rather than
thrashing — moving would only start a cold prompt cache on an account that will
refuse the request too. That decision is recorded as `rotate_skipped_all_spent`
in the debug log, naming the account that frees up first; the existing quota
advisory toast is what surfaces it on screen.

Rotation is evaluated after each response and after a refusal, so a spent
account is noticed on the next request rather than while the session sits idle.

Every automatic move raises a toast naming the new account, because the
provider/model label is applied once when OpenCode loads its config and cannot
be rewritten mid-session — without the toast the switch would be invisible.

A rotation is deliberately **not** persisted. The file behind the switcher holds
the account _you_ chose; letting one OpenCode window's exhaustion rewrite it
would move every other window too, and would erase a pin you set on purpose.

## In the TUI

The plugin that owns the accounts cannot draw anything: `PluginInput.tui` is
`never`. Drawing is a separate plugin kind, loaded from its own config file into
the TUI process, so `tui/claude-auth-tui.tsx` is a second entry point. The two
share state only through files on disk -- the selection file, the quota cache,
the telemetry log and the config -- which is why nothing here needs the server
plugin to be running in the same process.

Install by adding its absolute path to `~/.config/opencode/tui.json`:

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/absolute/path/to/tui/claude-auth-tui.tsx"],
}
```

It uses the host's `@opentui/solid`; the server plugin keeps its zero runtime
dependencies, because the two never share a module.

### Always on screen

A chip beside the prompt:

```
⇄ rr-123 · Team 2 · 5h 24%
```

The arrangement in force, the account that actually served last, and its 5-hour
utilisation. Only the 5h window: it is the one that moves during a session, and
this sits next to an input box.

A section in the sidebar, where there is room for the rest:

```
Claude Auth (balancing - rr-123 · 1 off)
  ●  Team 2   5h 24% · wk 57% · 44% reqs
  ·  Team 1   refused · 5h 104% · wk 57% · 28% reqs
  ·  Team 3   5h 24% · wk 57% · 27% reqs
```

Colour means load and nothing else -- green below the warning threshold, yellow
at it, red at the window or while being refused, muted when nothing has been
read. Which account is serving is the filled marker and the brighter name. Two
facts on two channels: colouring by "is it serving" made a healthy idle account
and an exhausted one look identical, which is the one comparison this list
exists to support.

The thresholds are the configured `quotaWarnAt` and `quotaWeeklyWarnAt`, so the
colour cannot disagree with the toast the plugin would raise.

Request share is there because quota percentages cannot answer "is the balancer
actually spreading load": two accounts can sit at the same utilisation while one
serves everything.

Both refresh every four seconds, from two small file reads. The Keychain is
touched at start-up and when a picker opens, never on the poll.

### Commands

| command        | default key | what it is for                                      |
| -------------- | ----------- | --------------------------------------------------- |
| `/cc-account`  | `<leader>a` | choose a preset, Auto, or pin one account           |
| `/cc-accounts` | `<leader>A` | manage accounts and the arrangements they belong to |
| `/cc-config`   | `<leader>c` | the settings that apply without a restart           |
| `/cc-stats`    | `<leader>s` | usage per session, last 24h                         |

### /cc-account

Presets, then Auto, then the individual accounts, each with its quota. Picking
one writes the selection file and nothing else -- no `authorize()`, no
`auth.json` rewrite, no provider rebuild. That is the whole reason it exists
next to the provider auth flow, which does all three.

### /cc-accounts

- **Accounts in use** -- include or exclude an account. This writes the
  `accounts` allow-list, where an empty list means "all": disabling one writes
  the others explicitly, re-enabling everything writes `[]` again rather than
  pinning today's set, and disabling the last one is refused, because obeying it
  would empty the list and re-enable everything.
- **Re-read the Keychain** -- pick up an account added or removed since the
  session started, without restarting.
- **Rename** -- writes `accountNames`. An empty name clears the override and
  returns the account to its derived name.
- **Presets** -- create, delete, change the strategy, and toggle which accounts
  belong. A preset's accounts are _references_, resolved the way the balancer
  resolves them, so a hand-written `"Acme 1"` is understood and preserved;
  references that resolve to nothing are listed as `[?]` and can be removed.
  Presets built from `pools` are listed and marked read-only -- tiered failover
  is a list of groups each with its own strategy, and a one-line dialog editing
  that would be a worse text editor than the one already open.

### /cc-config

Twenty-one settings in four sections -- Balancing, Quota, Tokens, Diagnostics --
each row carrying its label, current value, description and config key, so
anything seen here can still be found in the file.

Keys with a fixed vocabulary are chosen from a list, so a typo is not
expressible. Ratios and durations are typed and validated before the write, and
the validation is strict on purpose: `sanitize()` never rejects, it falls back
to the default, so asking it "did you keep this" answers yes to everything and
would write `switchAt: "abc"` as 0.95 while reporting success.

Keys that need a restart are not offered at all. An editor that appears to work
and changes nothing until restart is worse than no editor.

### /cc-stats

Sessions from the last 24 hours, newest first. Selecting one opens its detail:
rate as well as count, failures broken down by status, the slowest request
alongside the average, per-account share, and how far each account's 5h window
moved while it ran.

That last figure is labelled an upper bound rather than a cost. The window is
consumed by every session at once, so attributing its movement to one of them
would be a lie.

With `captureRequests` on it also reports request size split into system, tools
and messages, which separates the overhead paid on every request from the
conversation. Token figures are shown as `~`, from four bytes each -- a rule of
thumb that holds badly for code and JSON, which is most of a system prompt.

### Writes

Every screen writes the same way: surgically into the JSONC, via a temp file and
a rename, then the config cache is dropped so the next read is the file rather
than the answer it gave a moment ago.

Surgical because this file is JSONC and its comments are the only documentation
at the point of use; a parse-and-serialise round trip would delete every one.
The writer tracks strings, line and block comments and brace depth, so a key
named inside a comment, or nested inside `presets`, is never mistaken for the
top-level one. A scan that reaches end of file is refused rather than written.

### Strategy parameters

Most strategies take none: `round-robin`, `random` and `p2c` are fully described
by the account list. The rest read something:

| strategy                     | parameter                      | where                               |
| ---------------------------- | ------------------------------ | ----------------------------------- |
| `sticky`                     | `switchAt`, `switchWindow`     | `/cc-config` -> Balancing           |
| `least-loaded`, `least-used` | `switchWindow`, `quotaMaxAge`  | `/cc-config`                        |
| `priority`                   | the order of the accounts list | the order they appear in `accounts` |
| `weighted`                   | `weights`, per account         | the preset, or top level            |

```jsonc
{
  "presets": {
    "mostly-a": {
      "strategy": "weighted",
      "accounts": ["Acme 1", "Acme 2"],
      "weights": { "Acme 1": 3, "Acme 2": 1 },
    },
  },
}
```

Weights live on the preset because the strategy does: a preset is a strategy
plus the accounts it runs over, and a weight means nothing without both. Keys
are the same references the accounts list accepts. A missing account weighs 1,
so only the ones that differ need naming.

A preset that sets no weights does not inherit the top-level ones. Otherwise the
ratio would come from a setting the preset never mentions, which is the same
class of surprise as a pool inheriting accounts.

Pool-based presets keep their own per-tier weights, unchanged.

### Irreversible actions

Deleting a preset asks first, naming what goes with it. Everything else in the
TUI is one selection away from being put back -- a toggled account, a rename, a
changed strategy -- so only the delete is gated. A confirmation on a reversible
action is noise that teaches the eye to skip confirmations.

Two refusals are not confirmations but hard stops, because obeying them would do
the opposite of what was asked: disabling the last enabled account (an empty
allow-list means "all") and removing the last account from a preset (a preset
matching nothing is fallen through silently).

### Getting back

Select screens carry a `← Back` row. Escape in a text box returns to the screen
that opened it; escape in a list closes outright.

The asymmetry is the API's rather than a preference. `TuiDialogStack.replace()`
discards the stack and installs one item, and fires every existing `onClose`
_before_ doing so -- so `onClose` cannot distinguish "escaped" from "moved
forward", there is nothing to pop, and no dialog-scoped keybinding is exposed.
Text boxes get escape-to-return through `onClose` with two guards (one
suppressing deliberate navigation, one making each handler single-shot, since
without either it is a loop). Lists get a visible row instead, which needs no
guards and can be seen rather than remembered.

### What the TUI cannot do

- **Change the provider label under the prompt.** `Anthropic (LB: rr-123)` is
  the provider name, written once per instance by the `config` hook, and
  `TuiState.provider` is `readonly` with no setter. It is a start-up snapshot,
  which is why the chip and the sidebar exist. It also describes the _policy_,
  never the account serving -- under a preset that changes constantly.
- **Edit `pools`.** See above.
- **Edit the keys consumed once at start-up**: `debug`, `logLevel`,
  `logEvents`, `logMaxSize`, `logKeep`, `tools`, `accountLabel`.

## OpenCode integration points

What this plugin attaches to, and the constraint each surface turned out to
carry. Recorded because several of them are not documented and cost a
measurement to establish.

| surface                    | used for                                                        | constraint                                                                                                                                                               |
| -------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auth.loader`              | supplying credentials per request                               | —                                                                                                                                                                        |
| `auth.methods[].authorize` | the account switcher in `opencode auth login`                   | its callback returns credentials, which OpenCode persists; the server does **not** dispose anything on success (`provider/auth.ts` → `Auth.set` → `writeJson`, no event) |
| `config` hook              | decorating the provider name with the active arrangement        | runs once per instance. Never invents a provider entry: doing so crashed every provider on 1.18.30                                                                       |
| `chat.headers`             | stamping the session id so a session can keep one account       | the marker is stripped centrally before the request leaves                                                                                                               |
| custom `fetch`             | routing, telemetry, quota reading, the prefill retry            | the only place that sees a response, so every measurement originates here                                                                                                |
| `tool`                     | `claude_auth_status`, `claude_auth_select`, `claude_auth_usage` | loaded by dynamic import: a static one cancels 28 node:test subtests                                                                                                     |
| `event`                    | idle-time rotation                                              | —                                                                                                                                                                        |
| TUI `slots`                | the chip and the sidebar section                                | `session_prompt_right` and `sidebar_content`; a separate plugin kind, `PluginInput.tui` is `never`                                                                       |
| TUI `keymap.registerLayer` | the four commands and their keys                                | global commands only; no dialog-scoped binding exists                                                                                                                    |
| TUI `ui.dialog`            | every screen                                                    | `replace`/`clear`, not `open`/`close`; replaces the stack rather than pushing                                                                                            |
| TUI `ui.DialogPrompt`      | the three text boxes                                            | declares `onCancel` and never calls it; escape is the stack's, via `onClose`                                                                                             |
| TUI `ui.DialogSelect`      | every list                                                      | option text is `title`, not `label`; `category` renders as a real heading                                                                                                |
| TUI `theme.current`        | the health colours                                              | `success`, `warning`, `error`, `text`, `textMuted`                                                                                                                       |

The SDK is pinned to the running binary's exact version. Three different
versions were in play at one point -- the lockfile held 1.2.27, a sibling
checkout 1.17.1, the binary 1.18.31 -- so the TUI entry had been written against
types matching nothing that runs.

## Troubleshooting

| Problem                                             | Solution                                                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| "Credentials not found"                             | Run `claude` to authenticate with Claude Code first                                                                                       |
| "Keychain is locked"                                | Run `security unlock-keychain ~/Library/Keychains/login.keychain-db`                                                                      |
| "Token expired and refresh failed"                  | The plugin runs `claude` CLI to refresh automatically. If this fails, re-authenticate manually by running `claude`                        |
| Not working on Linux/Windows                        | Ensure `~/.claude/.credentials.json` exists (or `$CLAUDE_CONFIG_DIR/.credentials.json` if that env var is set). Run `claude` to create it |
| Keychain access denied                              | Grant access when macOS prompts you                                                                                                       |
| Keychain read timed out                             | Restart Keychain Access (can happen on macOS Tahoe)                                                                                       |
| "Credentials are unavailable or expired"            | Run `claude` to refresh your Claude Code credentials                                                                                      |
| "Extra usage is required for long context requests" | Your conversation exceeded 200k tokens. See [Long context (1M)](#long-context-1m) below                                                   |
| Plugin not updating to latest version               | Delete the cached package: `rm -rf ~/.cache/opencode/packages/opencode-claude-auth@latest/` then restart OpenCode                         |

### Diagnostic logging

If you're hitting auth errors that are hard to reproduce, enable debug logging to capture the full auth flow:

```bash
export CLAUDE_AUTH_DEBUG=1
```

Restart OpenCode and reproduce the issue. The plugin writes structured JSON logs to `~/.local/share/opencode/claude-auth-debug.log`. All secrets (tokens, API keys) are automatically redacted — the log file is safe to paste into a GitHub issue.

To write logs to a custom path:

```bash
export CLAUDE_AUTH_DEBUG=/tmp/claude-auth-debug.log
```

Disable when done:

```bash
unset CLAUDE_AUTH_DEBUG
```

## Configuration

Settings live in `~/.config/opencode/claude-auth.jsonc`. Edits apply within a
few seconds — no new shell, no OpenCode restart, which is the main reason to
prefer it over environment variables.

```jsonc
{
  "debug": true, // true, false, or a log file path
  "logLevel": "info", // info | warn | error
  "logEvents": "", // "refresh,quota", "*_failed", "-keychain", "errors"
  "logMaxSize": "5MB",
  "logKeep": 3,
  "quotaProbe": true, // fill every switcher row with quota
  "toastOnRefresh": false, // failures always toast; this adds successes
  "accountLabel": "both", // provider | model | both | off
}
```

Precedence, least specific first:

1. defaults
2. `~/.config/opencode/claude-auth.jsonc`
3. `<project>/claude-auth.jsonc`
4. inline options in `opencode.jsonc` — `["...opencode-claude-auth", { "quotaProbe": true }]`
5. `CLAUDE_AUTH_*` environment variables

Environment stays highest so a single command can override without editing
anything (`CLAUDE_AUTH_DEBUG_EVENTS=refresh opencode`), but it is no longer
where configuration is expected to live. A malformed file contributes nothing
rather than failing the plugin, and an unparseable environment variable is
dropped rather than reverting the key to its default — so a typo cannot quietly
undo what the config file says.

Every key is available on all three surfaces: the config file, the inline plugin
options, and the environment. A test enumerates the config type to keep that
true, because ten keys had previously drifted into being file-only.

| key                    | environment variable                     |
| ---------------------- | ---------------------------------------- |
| `debug`                | `CLAUDE_AUTH_DEBUG`                      |
| `logLevel`             | `CLAUDE_AUTH_DEBUG_LEVEL`                |
| `logEvents`            | `CLAUDE_AUTH_DEBUG_EVENTS`               |
| `logMaxSize`           | `CLAUDE_AUTH_DEBUG_MAX_SIZE`             |
| `logKeep`              | `CLAUDE_AUTH_DEBUG_KEEP`                 |
| `quotaProbe`           | `CLAUDE_AUTH_QUOTA_PROBE`                |
| `toastOnRefresh`       | `CLAUDE_AUTH_TOAST_REFRESH`              |
| `accountLabel`         | `CLAUDE_AUTH_ACCOUNT_LABEL`              |
| `refreshCheckInterval` | `CLAUDE_AUTH_REFRESH_CHECK_INTERVAL`     |
| `refreshBeforeExpiry`  | `CLAUDE_AUTH_REFRESH_BEFORE_EXPIRY`      |
| `noticeCooldown`       | `CLAUDE_AUTH_NOTICE_COOLDOWN`            |
| `quotaProbeMaxAge`     | `CLAUDE_AUTH_QUOTA_PROBE_MAX_AGE`        |
| `quotaMaxAge`          | `CLAUDE_AUTH_QUOTA_MAX_AGE`              |
| `quotaWarnAt`          | `CLAUDE_AUTH_QUOTA_WARN_AT`              |
| `quotaWeeklyWarnAt`    | `CLAUDE_AUTH_QUOTA_WEEKLY_WARN_AT`       |
| `quotaAlternativeAt`   | `CLAUDE_AUTH_QUOTA_ALTERNATIVE_AT`       |
| `configReloadInterval` | `CLAUDE_AUTH_CONFIG_RELOAD_INTERVAL`     |
| `accounts`             | `CLAUDE_AUTH_ACCOUNTS` (comma-separated) |
| `autoSwitch`           | `CLAUDE_AUTH_AUTO_SWITCH`                |
| `switchAt`             | `CLAUDE_AUTH_SWITCH_AT`                  |
| `switchWindow`         | `CLAUDE_AUTH_SWITCH_WINDOW`              |
| `switchOn429`          | `CLAUDE_AUTH_SWITCH_ON_429`              |
| `strategy`             | `CLAUDE_AUTH_STRATEGY`                   |
| `bindBy`               | `CLAUDE_AUTH_BIND_BY`                    |
| `pinBlocksRotation`    | `CLAUDE_AUTH_PIN_BLOCKS_ROTATION`        |
| `pools`                | `CLAUDE_AUTH_POOLS` (JSON)               |
| `ejectFor`             | `CLAUDE_AUTH_EJECT_FOR`                  |
| `presets`              | `CLAUDE_AUTH_PRESETS` (JSON)             |
| `preset`               | `CLAUDE_AUTH_PRESET`                     |
| `tools`                | `CLAUDE_AUTH_TOOLS`                      |
| `captureRequests`      | `CLAUDE_AUTH_CAPTURE_REQUESTS`           |

Names follow `camelCase` -> `CLAUDE_AUTH_SCREAMING_SNAKE`, except the six that
shipped before that convention and are kept as they are rather than renamed.

One asymmetry worth knowing: the config file is re-read every few seconds, so
editing it takes effect in a running OpenCode. A process cannot have its own
environment changed from outside, so `CLAUDE_AUTH_*` is fixed for the life of
the run. To flip something mid-session — capture especially — edit the file.

### Log format

Each line is one JSON object with a fixed envelope, so a log can be filtered and
aggregated without knowing the event vocabulary:

```json
{
  "v": 1,
  "ts": "2026-07-30T16:38:47.440Z",
  "sid": "0ehcaahc",
  "level": "info",
  "group": "keychain",
  "event": "keychain_list",
  "servicesFound": ["..."]
}
```

| field   | meaning                                                        |
| ------- | -------------------------------------------------------------- |
| `v`     | schema version                                                 |
| `sid`   | per-process id — several opencode processes append to one file |
| `level` | `info` / `warn` / `error`, derived from the event name         |
| `group` | event family (`refresh`, `keychain`, `quota`, …)               |

`CLAUDE_AUTH_DEBUG_LEVEL=warn` (or `error`) drops everything below that level.

### Choosing what to log

A start-up logs around thirty lines across a dozen event types, most of which are
irrelevant to any given question — a single keychain read alone fires eight times.
`CLAUDE_AUTH_DEBUG_EVENTS` narrows it to a comma-separated list of patterns:

```bash
export CLAUDE_AUTH_DEBUG_EVENTS=quota              # one group
export CLAUDE_AUTH_DEBUG_EVENTS=refresh,quota      # several
export CLAUDE_AUTH_DEBUG_EVENTS='*_failed'         # glob on the whole name
export CLAUDE_AUTH_DEBUG_EVENTS=errors             # alias: failure-shaped events
export CLAUDE_AUTH_DEBUG_EVENTS=-keychain,-cache   # everything except these
export CLAUDE_AUTH_DEBUG_EVENTS=refresh,-refresh_started
```

A bare name matches its whole group, so `refresh` covers `refresh_started`,
`refresh_success` and so on — but not `proactive_refresh_check`, which is its own
group. Exclusions (`-` or `!`) always win. Leaving the variable unset logs
everything, so existing setups are unchanged.

Groups: `account`, `auth`, `cache`, `credentials`, `fetch`, `keychain`, `plugin`,
`proactive_refresh`, `quota`, `refresh`, `sync`, `writeback`.

Logs are written to a file, never to the terminal, so they cannot corrupt the TUI.

### Notifications

Some credential events change which account serves your requests without any
action on your part, and were previously visible only in the log. These raise a
toast:

- a refresh that failed on every path,
- a silent fallback to a different account because the intended one could not be
  refreshed.

A successful refresh is routine and stays quiet unless
`CLAUDE_AUTH_TOAST_REFRESH=1` is set. Repeats of the same condition are
suppressed for ten minutes, so a persistent failure notifies once rather than
every sync tick.

## Long context (1M)

1M token context is supported natively — the API no longer requires a beta flag for it, so the plugin doesn't send the legacy `context-1m-2025-08-07` header.

If your plan doesn't cover long context billing, requests beyond the standard window fail with "Extra usage is required for long context requests". When a long context error is caused by a beta flag (e.g. one added via `ANTHROPIC_BETA_FLAGS`), the plugin retries without the offending flag.

## Validating OAuth refresh

To verify the direct OAuth token refresh works with your credentials:

```bash
pnpm run validate:oauth           # refresh + write-back (safe, keeps credentials valid)
pnpm run validate:oauth -- --dry-run  # show what would be sent without making the request
```

This reads your stored credentials, calls Anthropic's OAuth token endpoint, and writes the new tokens back to storage. Refresh tokens rotate on each use, so write-back is enabled by default to keep your stored credentials valid.

## Environment variable overrides

All configurable parameters can be overridden via environment variables. If Anthropic changes something before we publish an update, set an env var and keep working:

| Variable                            | Description                                                                                                                                                                            | Default                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ANTHROPIC_CLI_VERSION`             | Claude CLI version for user-agent and billing headers                                                                                                                                  | `config.ccVersion` in [`src/model-config.ts`](src/model-config.ts) |
| `ANTHROPIC_USER_AGENT`              | Full User-Agent string (overrides CLI version)                                                                                                                                         | `claude-cli/{version} (external, sdk-cli)`                         |
| `ANTHROPIC_BETA_FLAGS`              | Comma-separated beta feature flags                                                                                                                                                     | `baseBetas` list in [`src/model-config.ts`](src/model-config.ts)   |
| `CLAUDE_AUTH_DEBUG`                 | Enable diagnostic logging (`1` for default path, or a custom file path)                                                                                                                | disabled                                                           |
| `CLAUDE_CONFIG_DIR`                 | Claude Code config directory used for the credentials-file fallback (reads `$CLAUDE_CONFIG_DIR/.credentials.json`). macOS still checks the Keychain first.                             | `~/.claude`                                                        |
| `OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS` | Max ms the plugin waits when honouring a 429/529 `retry-after` header. Beyond this cap the response surfaces immediately so OpenCode doesn't appear to hang on hour-long quota resets. | `30000`                                                            |

Example:

```bash
export ANTHROPIC_CLI_VERSION=2.2.0
```

## How it works (technical)

- Registers an `auth.loader` with a custom `fetch` that intercepts all Anthropic API requests
- Sets `Authorization: Bearer` with fresh OAuth tokens (cached in memory, 30s TTL, updated in-place after refresh)
- Translates tool names between OpenCode and Anthropic API formats (adds/strips `mcp_` prefix)
- Buffers SSE response streams at event boundaries for reliable tool name translation
- Injects Claude Code identity into system prompts via `experimental.chat.system.transform`
- Sets required API headers (beta flags, billing, user-agent) with model-aware selection
- On macOS, enumerates all `Claude Code-credentials*` Keychain entries and labels them by subscription tier
- Provides an account switcher via `opencode auth login` when multiple accounts are found; persists selection to `~/.local/share/opencode/claude-account-source.txt`
- Syncs credentials to `auth.json` on startup and every 5 minutes as a fallback (sync never triggers refresh; refresh is lazy, only on API requests)
- On Windows, writes to both `%USERPROFILE%\.local\share\opencode\auth.json` and `%LOCALAPPDATA%\opencode\auth.json`
- Retries API requests on 429 (rate limit) and 529 (overloaded) with exponential backoff, respecting `retry-after` headers
- When a token is within 60 seconds of expiry, refreshes directly via `POST https://claude.ai/v1/oauth/token` (no LLM tokens consumed). Falls back to `claude` CLI if the direct refresh fails. New tokens are written back to Keychain (macOS) or credentials file (Linux/Windows) to keep stored credentials in sync with rotated refresh tokens
- If credentials aren't OAuth-based, the auth loader returns `{}` and falls through to API key auth
- If credentials are unavailable or unreadable, the plugin disables itself and OpenCode continues without Claude auth

## Credits and lineage

This is a fork, and most of what it is rests on other people's work.

**[griffinmartin/opencode-claude-auth](https://github.com/griffinmartin/opencode-claude-auth)**
by **Griffin Martin** is the original and the upstream. It is where the idea and
the whole credential path come from: reading Claude Code's own OAuth tokens out
of the Keychain, refreshing them, and presenting them to OpenCode as a provider.
MIT licensed, actively maintained, and the reason this plugin exists at all.

This fork inherits **153 commits** from it and adds **86**. It currently sits
**25 commits behind** upstream, and the fork link on GitHub is kept deliberately
so those can still be pulled and anything generally useful can go back.

**[robbash/opencode-claude-auth](https://github.com/robbash/opencode-claude-auth)**
by **Robert Sternberg** contributed the piece this fork leans on hardest: reading
the Keychain _comment_ for an entry, via `security dump-keychain`, so an account
has a name a person recognises instead of a hex suffix. Everything here that
talks about "Team 2" or resolves a preset reference like `"Acme 1"` is standing
on that. It survives in `src/keychain.ts` and was explicitly preserved across an
upstream merge.

The inherited history carries commits from:

- Griffin Martin
- Minzi ✨
- 이주형 JhinLee
- Ehsanur Rahman Rhythm
- Finn Kumkar
- FranzCh
- Hristo Karamanliev
- JaeHyeonKim
- Kieran Bond
- Kunaldeep Singh
- Nandana Dileep
- Robert Sternberg
- SeaL773
- Xuan Guo

...along with several contributors whose commits carry only a handle.

### What this fork added

Multi-account load balancing with eight strategies, pools and named presets;
per-session account binding; quota tracking from the rate-limit headers; usage
telemetry and reporting; request introspection for understanding prompt cost;
recovery from assistant-prefill refusals; and a TUI plugin for seeing and
changing all of it without leaving OpenCode.

None of that would have been worth building without a credential layer that
already worked.

## Disclaimer

This plugin uses Claude Code's OAuth credentials to authenticate with Anthropic's API. Anthropic's Terms of Service state that Claude Pro/Max subscription tokens should only be used with official Anthropic clients. This plugin exists as a community workaround and may stop working if Anthropic changes their OAuth infrastructure. Use at your own discretion.

## License

MIT, and the copyright notice in `LICENSE` is upstream's, unchanged. See
[Credits and lineage](#credits-and-lineage).
