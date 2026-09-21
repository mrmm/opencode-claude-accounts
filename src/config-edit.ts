/**
 * Editing the config file in place, from the TUI.
 *
 * The file is re-read on a stat check, so a write here takes effect in a
 * running session without a restart -- but only for the keys that are read at
 * decision time. The ones copied into module state at start-up (the logging
 * group, `tools`, `accountLabel`) are deliberately absent from EDITABLE: an
 * editor that silently does nothing until a restart is worse than no editor.
 *
 * Writes are surgical rather than a parse-and-serialise round trip. The config
 * file is JSONC and the comments in it are the only documentation at the point
 * of use; JSON.stringify would delete every one of them.
 */

/**
 * How each key is edited.
 *
 * Anything with a fixed vocabulary is chosen from a list, so a typo is not
 * expressible. Ratios and durations stay typed, because a list of eight
 * thresholds is worse than a field -- but they are validated by running the
 * real sanitize() over the value before it is written. That is the point: the
 * check cannot drift from what the config actually accepts, because it *is*
 * what the config accepts. A value the sanitiser would drop is refused with a
 * reason rather than written, so the dialog can never report success and change
 * nothing.
 *
 * `preset` is the one list that cannot be written down here, because it is
 * whatever the user configured; optionsFor() reads it at open time.
 */
import { STRATEGIES } from "./balance/index.ts"
import { parseDuration, parseRatio } from "./config.ts"

/**
 * Every strategy the balancer implements, in the order it declares them.
 *
 * Object.keys over the registry rather than a list beside it: adding a strategy
 * to the balancer makes it appear here, and a test asserts the two cannot
 * diverge.
 */
export const STRATEGY_NAMES: string[] = Object.keys(STRATEGIES)

export type EditableKind = "boolean" | "enum" | "preset" | "number"

export type Editable = {
  /** The config key, shown alongside the label so the file stays searchable. */
  key: string
  /** What a reader calls it. */
  label: string
  /** Heading it sits under in the dialog. */
  section: string
  kind: EditableKind
  /** Allowed values, for `enum`. Absent for the other kinds. */
  options?: string[]
  hint: string
  /** Shown as the placeholder for `number`, which is the only typed kind. */
  example?: string
  /** Which shape a `number` must take. Absent for the other kinds. */
  numeric?: "ratio" | "duration"
}

/** No key is free text: every one of these resolves to a list of choices. */
export const EDITABLE: Editable[] = [
  {
    key: "strategy",
    label: "Strategy",
    section: "Balancing",
    kind: "enum",
    // Derived from the balancer's own registry, never retyped. A UI list that
    // drifts offers a strategy that does not exist, or hides one that does --
    // and the drift is silent, because both halves type-check on their own.
    options: STRATEGY_NAMES,
    hint: "how the balancer picks",
  },
  {
    key: "preset",
    label: "Preset",
    section: "Balancing",
    kind: "preset",
    hint: "named arrangement in force",
  },
  {
    key: "autoSwitch",
    label: "Auto-switch",
    section: "Balancing",
    kind: "boolean",
    hint: "move off an account by itself",
  },
  {
    key: "switchAt",
    label: "Switch at",
    section: "Balancing",
    kind: "number",
    numeric: "ratio",
    example: "0.95",
    hint: "utilisation that triggers a move",
  },
  {
    key: "switchWindow",
    label: "Switch window",
    section: "Balancing",
    kind: "enum",
    options: ["5h", "7d", "binding"],
    hint: "which window switchAt reads",
  },
  {
    key: "switchOn429",
    label: "Switch when refused",
    section: "Balancing",
    kind: "boolean",
    hint: "move when refused",
  },
  {
    key: "bindBy",
    label: "Bind sessions",
    section: "Balancing",
    kind: "enum",
    options: ["none", "session"],
    hint: "keep a session on one account",
  },
  {
    key: "pinBlocksRotation",
    label: "Pin blocks rotation",
    section: "Balancing",
    kind: "boolean",
    hint: "a pin disables balancing",
  },
  {
    key: "ejectFor",
    label: "Eject a failing account for",
    section: "Balancing",
    kind: "number",
    numeric: "duration",
    example: "5m",
    hint: "how long a failing account sits out",
  },
  {
    key: "useCredits",
    label: "Use paid credits",
    section: "Balancing",
    kind: "boolean",
    hint: "spend overflow when every account's included allowance is gone",
  },
  {
    key: "quotaProbe",
    label: "Probe quota in background",
    section: "Quota",
    kind: "boolean",
    hint: "probe quota in the background",
  },
  {
    key: "quotaWarnAt",
    label: "Warn at (5h)",
    section: "Quota",
    kind: "number",
    numeric: "ratio",
    example: "0.8",
    hint: "warn at this 5h utilisation",
  },
  {
    key: "quotaWeeklyWarnAt",
    label: "Warn at (weekly)",
    section: "Quota",
    kind: "number",
    numeric: "ratio",
    example: "0.8",
    hint: "warn at this weekly utilisation",
  },
  {
    key: "quotaAlternativeAt",
    label: "Suggest another below",
    section: "Quota",
    kind: "number",
    numeric: "ratio",
    example: "0.7",
    hint: "suggest another account below this",
  },
  {
    key: "quotaMaxAge",
    label: "Ignore readings older than",
    section: "Quota",
    kind: "number",
    numeric: "duration",
    example: "12h",
    hint: "ignore a reading older than this",
  },
  {
    key: "quotaProbeMaxAge",
    label: "Re-probe after",
    section: "Quota",
    kind: "number",
    numeric: "duration",
    example: "10m",
    hint: "re-probe after this",
  },
  {
    key: "refreshCheckInterval",
    label: "Check tokens every",
    section: "Tokens",
    kind: "number",
    numeric: "duration",
    example: "60s",
    hint: "how often tokens are checked",
  },
  {
    key: "refreshBeforeExpiry",
    label: "Refresh before expiry by",
    section: "Tokens",
    kind: "number",
    numeric: "duration",
    example: "5m",
    hint: "refresh this long before expiry",
  },
  {
    key: "retryPrefillError",
    label: "Recover prefill refusals",
    section: "Diagnostics",
    kind: "boolean",
    hint: "recover from prefill refusals",
  },
  {
    key: "captureRequests",
    label: "Record requests",
    section: "Diagnostics",
    kind: "enum",
    options: ["off", "shape", "full", "messages"],
    hint: "record requests (messages = conversation on disk)",
  },
  {
    key: "noticeCooldown",
    label: "Quiet period between toasts",
    section: "Diagnostics",
    kind: "number",
    numeric: "duration",
    example: "10m",
    hint: "quiet period between repeat toasts",
  },
  {
    key: "configReloadInterval",
    label: "Re-read this file every",
    section: "Diagnostics",
    kind: "number",
    numeric: "duration",
    example: "3s",
    hint: "how often this file is re-read",
  },
]

/** Marker value for clearing `preset`, distinct from a preset actually named "". */
export const NO_PRESET = "__none__"

/** The JSON literal for a chosen value. */
export function toLiteral(kind: EditableKind, raw: string): string {
  if (kind === "boolean") return raw === "true" ? "true" : "false"
  // Clearing a preset means an empty string, which is what resolveActiveConfig
  // reads as "no preset" -- not the literal word none.
  if (kind === "preset" && raw === NO_PRESET) return '""'
  // A ratio is written as a number so the file reads as JSON would, even though
  // parseRatio would accept the quoted form too.
  if (raw.trim() !== "" && Number.isFinite(Number(raw))) {
    return String(Number(raw))
  }
  return JSON.stringify(raw)
}

type Scan = { depth: number; inString: boolean; line: boolean; block: boolean }

/**
 * Walk JSONC tracking what each character is part of.
 *
 * Needed because a key name can appear inside a string or a comment -- this
 * file's comments mention `"strategy"` by name -- and replacing there would
 * corrupt the file rather than edit it.
 */
function scanner(text: string): { depthAt: number[]; codeAt: boolean[] } {
  const depthAt: number[] = Array.from({ length: text.length }, () => 0)
  const codeAt: boolean[] = Array.from({ length: text.length }, () => false)
  const st: Scan = { depth: 0, inString: false, line: false, block: false }
  let escape = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    const next = text[i + 1]
    if (st.line) {
      if (c === "\n") st.line = false
    } else if (st.block) {
      if (c === "*" && next === "/") {
        st.block = false
        i++
        continue
      }
    } else if (st.inString) {
      if (escape) escape = false
      else if (c === "\\") escape = true
      else if (c === '"') st.inString = false
    } else if (c === "/" && next === "/") {
      st.line = true
      i++
      continue
    } else if (c === "/" && next === "*") {
      st.block = true
      i++
      continue
    } else if (c === '"') {
      st.inString = true
    } else if (c === "{" || c === "[") {
      st.depth++
    } else if (c === "}" || c === "]") {
      st.depth--
    }
    depthAt[i] = st.depth
    codeAt[i] = !st.line && !st.block
  }
  return { depthAt, codeAt }
}

/**
 * The same text with one top-level key set to `literal`, comments intact.
 *
 * Returns null when the edit cannot be made safely -- no object to write into,
 * or a key that appears only inside a string or comment. A caller that gets
 * null must not fall back to rewriting the file.
 */
export function setJsoncValue(
  text: string,
  key: string,
  literal: string,
): string | null {
  const { depthAt, codeAt } = scanner(text)
  const needle = `"${key}"`

  for (
    let i = text.indexOf(needle);
    i !== -1;
    i = text.indexOf(needle, i + 1)
  ) {
    // Depth 1 = a direct member of the root object. depthAt is recorded after
    // the character, so the opening quote of a top-level key reads as 1.
    if (!codeAt[i] || depthAt[i] !== 1) continue

    let j = i + needle.length
    while (j < text.length && /\s/.test(text[j]!)) j++
    if (text[j] !== ":") continue
    j++
    while (j < text.length && /\s/.test(text[j]!)) j++

    // The value ends at the next comma belonging to the OBJECT that holds it,
    // or at that object's closing brace.
    //
    // The depth to compare against is the key's, not the value's. Taking it at
    // the value read 2 for an array, which is also the depth of the commas
    // *between its elements* -- so `"accounts": ["a","b","c"]` was truncated at
    // the comma after "a", leaving the rest of the array orphaned and, because
    // no terminator then matched, swallowing the remainder of the file. Scalars
    // were unaffected, which is why every earlier test passed.
    //
    // depthAt records the depth after each character, so a closing brace reads
    // one shallower than its contents: that is why the second test subtracts.
    let end = j
    const keyDepth = depthAt[i] ?? 1
    while (end < text.length) {
      const c = text[end]!
      if (codeAt[end]) {
        if (c === "," && depthAt[end] === keyDepth) break
        if (c === "}" && depthAt[end] === keyDepth - 1) break
      }
      end++
    }
    // A key that never terminates means the scan misread the document. Refusing
    // is the only safe answer: the alternative is what just happened -- writing
    // from here to EOF and destroying everything after it.
    if (end >= text.length) return null
    while (end > j && /\s/.test(text[end - 1]!)) end--

    return text.slice(0, j) + literal + text.slice(end)
  }

  // Not present: add it as the first member, where a reader will see it.
  const open = [...text].findIndex((c, i) => c === "{" && codeAt[i])
  if (open === -1) return null
  return `${text.slice(0, open + 1)}\n  "${key}": ${literal},${text.slice(open + 1)}`
}

/**
 * The settings list, grouped.
 *
 * `category` is what DialogSelect groups by, so the sections are real headings
 * rather than a naming convention. Each row carries three different things a
 * reader needs and which one line cannot hold: what it is called, what it is
 * set to, and what it does -- plus the config key itself, so anything seen here
 * can be found in the file afterwards.
 */
export function configRows(current: Record<string, unknown>): {
  title: string
  value: string
  description: string
  category: string
}[] {
  return EDITABLE.map((e) => ({
    title: `${e.label}: ${display(current[e.key])}`,
    value: e.key,
    description: `${e.hint}  (${e.key})`,
    category: e.section,
  }))
}

/** How a live config value reads in a list. */
export function display(v: unknown): string {
  if (typeof v === "string") return v === "" ? "(unset)" : v
  if (typeof v === "boolean") return v ? "on" : "off"
  if (typeof v === "number") {
    // Durations are stored as milliseconds; showing 43200000 helps nobody.
    if (v >= 1000 && v % 1000 === 0) {
      const s = v / 1000
      if (s % 3600 === 0) return `${s / 3600}h`
      if (s % 60 === 0) return `${s / 60}m`
      return `${s}s`
    }
    return String(v)
  }
  return v === undefined || v === null ? "(unset)" : String(v)
}

/**
 * The choices for one key, including the ones only known at runtime.
 *
 * `presets` is passed in rather than read here so this stays pure and the list
 * a user sees is exactly the list under test.
 */
export function optionsFor(
  e: Editable,
  current: unknown,
  presets: Record<string, { label?: string }> = {},
): { title: string; value: string; description?: string }[] {
  const raw: { title: string; value: string }[] =
    e.kind === "boolean"
      ? [
          { title: "on", value: "true" },
          { title: "off", value: "false" },
        ]
      : e.kind === "preset"
        ? [
            { title: "(none) - use strategy directly", value: NO_PRESET },
            ...Object.entries(presets).map(([name, p]) => ({
              title: p.label ? `${name} - ${p.label}` : name,
              value: name,
            })),
          ]
        : (e.options ?? []).map((v) => ({ title: v, value: v }))

  const now =
    e.kind === "boolean"
      ? String(Boolean(current))
      : e.kind === "preset" && (current === "" || current === undefined)
        ? NO_PRESET
        : String(current)

  return raw.map((o) => {
    const row: { title: string; value: string; description?: string } = {
      title: o.title,
      value: o.value,
    }
    if (o.value === now) row.description = "current"
    return row
  })
}

/**
 * Whether a typed value is really the shape it claims to be.
 *
 * This deliberately does NOT ask sanitize(), which was the first attempt and
 * was wrong: sanitize never rejects. Its parsers fall back to the default, so
 * `switchAt: "abc"` is kept as 0.95 and `ejectFor: "nonsense"` as five minutes.
 * Asking it "did you keep this" therefore answers yes to everything, and the
 * dialog would have written garbage while reporting success.
 *
 * Worse, the parsers are lenient in a way that is fine for a file a human edits
 * and reads back, but not for a dialog: parseRatio("5 minutes") returns 0.05,
 * having seen the 5 and read it as a percentage. So the shape is checked first,
 * strictly, and only then handed to the parser -- with a sentinel, so a parser
 * that gives up is distinguishable from one that returns the default.
 */
const UNPARSED = -1

export function validateValue(
  e: Editable,
  raw: string,
): { ok: true; literal: string } | { ok: false; reason: string } {
  const trimmed = raw.trim()
  if (trimmed === "") return { ok: false, reason: "cannot be empty" }

  const bad = (why: string) => ({
    ok: false as const,
    reason: e.example ? `${why} - try ${e.example}` : why,
  })

  if (e.numeric === "ratio") {
    // A bare fraction, or an explicit percentage. Nothing else.
    if (!/^(\d+(\.\d+)?%|0?\.\d+|[01](\.0+)?)$/.test(trimmed)) {
      return bad("not a ratio")
    }
    const parsed = parseRatio(trimmed, UNPARSED)
    if (parsed === UNPARSED || parsed <= 0 || parsed > 1) {
      return bad("must be above 0 and at most 1")
    }
    return { ok: true, literal: toLiteral(e.kind, trimmed) }
  }

  if (e.numeric === "duration") {
    if (!/^\d+(\.\d+)?(ms|s|m|h|d)$/.test(trimmed)) return bad("not a duration")
    const parsed = parseDuration(trimmed, UNPARSED)
    if (parsed === UNPARSED || parsed <= 0)
      return bad("must be longer than zero")
    return { ok: true, literal: JSON.stringify(trimmed) }
  }

  return { ok: true, literal: toLiteral(e.kind, trimmed) }
}
