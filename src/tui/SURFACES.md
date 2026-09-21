# TUI surfaces

Every place the plugin renders account state, and the one place each fact is
decided. Written so a change to what is displayed does not require auditing the
tree again.

Regenerate the line numbers with `rg -n` if they drift; the anchors are the
function names, which are stable.

## The two chokepoints

Almost nothing renders account state directly. Five surfaces funnel through two
functions, so a change to either reaches all five at once.

| | where | answers |
| --- | --- | --- |
| `quotaText()` | src/tui/chip.ts:108 | what the numbers SAY |
| `accountHealth()` | src/tui/chip.ts:194 | what colour they MEAN |

Add a fact to `quotaText` behind an opt-in flag and every caller that wants it
passes the flag; the ones that do not are untouched. That is how `resets` and
`spend` were added without editing five renderers.

## Display surfaces

| surface | built by | call site | shows |
| --- | --- | --- | --- |
| prompt chip | `formatChip` | src/tui/chip.ts:366 | 5h only, + `paid`. No room beside an input box |
| sidebar rows | `sidebarLines` | src/tui/chip.ts:407 | 5h + wk + resets + spend + request share |
| account picker | `buildPickerOptions` | src/tui/chip.ts:471 | 5h + spend |
| session detail | `detailRows` | src/tui/chip.ts:587 | 5h + wk + spend |
| accounts-in-use picker | inline | tui/claude-auth-tui.tsx:651 | 5h + wk + spend |
| toast / advisory | `buildAdvisory` | src/ui/advisory.ts:93 | **separate text path — does NOT use `quotaText`** |

The advisory is the exception worth remembering: it composes its own sentences
and will not inherit anything added to `quotaText`.

## Colour

`Health` (src/tui/chip.ts:162) maps to a theme colour in
`healthColour` (tui/claude-auth-tui.tsx:148). The theme offers
`success`, `warning`, `error`, `info`, `text`, `textMuted` — there is no wider
palette to reach for.

| state | colour | means |
| --- | --- | --- |
| `ok` | success | inside the allowance |
| `warn` | warning | past `quotaWarnAt`, still included |
| `paid` | info | allowance spent, credits covering it — **working, and costing money** |
| `critical` | error | genuinely unusable: no credits, or the cap is reached |
| `unknown` | textMuted | nothing has been read |

Hue carries ONE axis: what it costs to use this account. Which account is
serving is a separate channel — the filled marker and the brighter name —
because colouring by "is it serving" made a healthy idle account and an
exhausted one identical, which is the comparison the list exists to support.

## Where the facts come from

| fact | source | note |
| --- | --- | --- |
| 5h / weekly utilisation | response headers, and the usage probe | headers give a FRACTION, the probe a PERCENT |
| reset times | both | headers give unix seconds, the probe ISO strings |
| `status`, `representative` | response headers only | the probe has no counterpart, so a probe write MERGES |
| extra usage, spend, `limits[]` | usage probe only (`/api/oauth/usage`) | ~1 call/hour/account; a 429 blocks further probes |
| request share | `usage.jsonl` | answers "is load actually spread", which quota cannot |

## Adding a field — the recipe

1. Parse it into `AccountQuota` (src/balance/quota.ts:62).
2. Render it in `quotaText` behind an opt-in flag.
3. Pass the flag at whichever of the five call sites should show it.
4. If it changes what an account's state MEANS, extend `Health` and
   `healthColour` together — they are two halves of one decision.
5. The advisory does not inherit it. Update it separately or accept the drift.
