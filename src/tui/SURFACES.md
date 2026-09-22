# TUI surfaces

Every place the plugin renders account state, and the one place each fact is
decided. Written so a change to what is displayed does not require auditing the
tree again.

Regenerate the line numbers with `rg -n` if they drift; the anchors are the
function names, which are stable.

## The two chokepoints

Almost nothing renders account state directly. Five surfaces funnel through two
functions, so a change to either reaches all five at once.

|                   | where               | answers               |
| ----------------- | ------------------- | --------------------- |
| `quotaText()`     | src/tui/chip.ts:108 | what the numbers SAY  |
| `accountHealth()` | src/tui/chip.ts:194 | what colour they MEAN |

Add a fact to `quotaText` behind an opt-in flag and every caller that wants it
passes the flag; the ones that do not are untouched. That is how `resets` and
`spend` were added without editing five renderers.

## Display surfaces

| surface                | built by             | call site                   | shows                                             |
| ---------------------- | -------------------- | --------------------------- | ------------------------------------------------- |
| prompt chip            | `formatChip`         | src/tui/chip.ts:366         | 5h only, + `paid`. No room beside an input box    |
| sidebar rows           | `sidebarLines`       | src/tui/chip.ts:407         | 5h + wk + resets + spend + request share          |
| account picker         | `buildPickerOptions` | src/tui/chip.ts:471         | 5h + spend                                        |
| session detail         | `detailRows`         | src/tui/chip.ts:587         | 5h + wk + spend                                   |
| accounts-in-use picker | inline               | tui/claude-auth-tui.tsx:651 | 5h + wk + spend                                   |
| toast / advisory       | `buildAdvisory`      | src/ui/advisory.ts:93       | **separate text path — does NOT use `quotaText`** |

| sidebar header | inline | ../../tui/claude-auth-tui.tsx (`<b>Claude Auth</b>`) | section title + running version |

The version comes from `src/version.ts`, which reads `package.json` rather than
restating it. It is there to answer "is the build I just made the build that is
running" without reading a log -- a question that cost a debugging round once.
It is also on every `plugin_init` log line.

The advisory is the exception worth remembering: it composes its own sentences
and will not inherit anything added to `quotaText`. Its title must stay true of
EVERY account -- naming one window there claimed a uniformity that did not
exist, since the binding limit differs per account. Per-account detail belongs
in the message.

## Selection tiers

`selectAccount` walks these in order, and the `pool` on its decision says which
one answered. Cost increases down the list, so the order is the policy.

| tier                    | when                                                          |
| ----------------------- | ------------------------------------------------------------- |
| the strategy's own pick | an account is under `switchAt`                                |
| `over-threshold`        | all above `switchAt`, but something is still under its limit  |
| `credits`               | included allowance spent, paid overflow enabled and under cap |
| `exhausted`             | nothing left: refused, ejected, or capped including credits   |

`useCredits: false` removes the `credits` tier entirely, so a spent account is
simply spent and the plugin stops rather than bills. A single session can
decline on its own -- a row in `/cc-account`, under "This session" -- which
narrows only that session's view while the global setting still governs the
rest. Neither turns
credits off at Anthropic -- no API offers that, and this credential could not
use one if it did. They decline to ROUTE, which keeps this plugin's traffic
free while another client on the same account still spends.

`credits` sits below both free tiers deliberately: a free account at 98% is
cheaper than a paid one at 100%, and enabling credits must not start spending
them while any free headroom remains.

## Colour

`Health` (src/tui/chip.ts:162) maps to a theme colour in
`healthColour` (tui/claude-auth-tui.tsx:148). The theme offers
`success`, `warning`, `error`, `info`, `text`, `textMuted` — there is no wider
palette to reach for.

| state      | colour    | means                                                                 |
| ---------- | --------- | --------------------------------------------------------------------- |
| `ok`       | success   | inside the allowance                                                  |
| `warn`     | warning   | past `quotaWarnAt`, still included                                    |
| `paid`     | info      | allowance spent, credits covering it — **working, and costing money** |
| `critical` | error     | genuinely unusable: no credits, or the cap is reached                 |
| `unknown`  | textMuted | nothing has been read                                                 |

Hue carries ONE axis: what it costs to use this account. Which account is
serving is a separate channel — the filled marker and the brighter name —
because colouring by "is it serving" made a healthy idle account and an
exhausted one identical, which is the comparison the list exists to support.

## Keeping the figures current

Three triggers, all funnelling into the same `topUpQuota`, which refuses when
the reading is fresh and complete and when the endpoint has rate-limited us:

| trigger | when |
| --- | --- |
| `sync-tick` | the standing timer, `refreshCheckInterval` |
| `switcher-open` | opening the account picker |
| `spilling` | a response shows either window at or past its limit |

`spilling` is the one worth explaining: crossing into paid territory is the
moment the money figures matter AND the moment they are certainly stale, since
no header carries a balance. It is called unconditionally -- the freshness gate
is a ten-minute debounce and the 429 backoff is the endpoint's own guard, so a
third check here would only be a slower way to the same answer.

Manual: `/cc-accounts` -> "Refresh quota and credits now" ignores the freshness
gate for every account, and `/cc-debug` does the same before reporting. Neither
can ignore the rate limit; when refused, the toast says the figures are the
last ones reported rather than pretending they are current.

## Asking what it is doing

`/cc-debug` re-reads config, accounts and quota from disk, forces a probe
ignoring both the freshness gate and the 429 backoff, then writes
`~/.local/share/opencode/claude-auth-report.txt` and shows it. It reports FACTS
READ AT CALL TIME, never intent: the running build, what the cache holds per
account, which preset references resolve to nothing, and the config keys that
decide routing.

It exists because the alternative was a screenshot and a guess. Every fault in
this area so far was one of: the running build predated the fix, the cache held
no credit data, or a reference silently resolved to nothing -- and the report
prints all three without being asked.

## No code hot reload

`api.slots.register` returns an id and the API exposes no remover, so a
re-imported module would ADD a second sidebar section and chip beside the
originals. `api.command.register` and `event.on` do return unsubscribes, but
slots do not, and slots are half the surface. Code changes need a restart.

Data does not: config, presets, the selection file and the quota cache are all
re-read, and `/cc-debug` forces that immediately.

## Two processes, one plugin

The balancer runs in the opencode server; the dialogs run in the TUI worker.
They share nothing but files. Anything one sets and the other must read goes
through disk -- the selection file, the config, the quota cache, and the
per-session credit denials. An in-memory flag is invisible across that line,
and the failure is silent: the setter works, the reader never sees it.

`TuiCommand` carries no session id either (it is title/value/keybind and
nothing else), so a command that needs one borrows it from `sidebar_content`,
the slot that is handed it on every render. Note the renderer signature is
`(ctx, props)` -- the context comes first, and the props second.

## Where the facts come from

| fact                           | source                                | note                                                  |
| ------------------------------ | ------------------------------------- | ----------------------------------------------------- |
| 5h / weekly utilisation        | response headers, and the usage probe | headers give a FRACTION, the probe a PERCENT          |
| reset times                    | both                                  | headers give unix seconds, the probe ISO strings      |
| `status`, `representative`     | response headers only                 | the probe has no counterpart, so a probe write MERGES |
| extra usage, spend, `limits[]` | usage probe only (`/api/oauth/usage`) | ~1 call/hour/account; a 429 blocks further probes     |
| request share                  | `usage.jsonl`                         | answers "is load actually spread", which quota cannot |

## Adding a field — the recipe

1. Parse it into `AccountQuota` (src/balance/quota.ts:62).
2. Render it in `quotaText` behind an opt-in flag.
3. Pass the flag at whichever of the five call sites should show it.
4. If it changes what an account's state MEANS, extend `Health` and
   `healthColour` together — they are two halves of one decision.
5. The advisory does not inherit it. Update it separately or accept the drift.
