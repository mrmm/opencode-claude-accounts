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
