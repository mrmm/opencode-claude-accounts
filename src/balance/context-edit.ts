/**
 * Server-side context editing: letting Anthropic clear old tool results from a
 * long conversation instead of carrying every one to the context limit.
 *
 * The API exposes this as a `context_management.edits` array on a `/v1/messages`
 * request, gated behind the `context-management-2025-06-27` beta (already in the
 * base beta set, so no header work is needed here). A `clear_tool_uses_20250919`
 * edit removes the oldest tool-use/tool-result pairs once the input crosses a
 * token trigger, keeping the most recent `keep`.
 *
 * It is off by default and opted into, because clearing invalidates the cached
 * prefix: everything before the cleared span must be re-written to the cache on
 * the next turn. `clearAtLeast` exists to make that rewrite worth paying for —
 * clear a meaningful chunk or none at all. Thinking is deliberately never
 * cleared: on Claude 5.1+ server-side editing does not invalidate thinking, so
 * a `clear_thinking` edit would only cost a cache rewrite for no benefit.
 *
 * Pure by construction — `applyContextEditing` and `contextEditDisabledBy400`
 * are functions of their inputs, so the policy is testable without a network.
 * The thin shell that calls them lives in the plugin's fetch.
 */

import type { ClaudeAuthConfig } from "../config.ts"

/** Resolved, numeric form of the config union. */
export type ContextEditingSettings = {
  /** Input-token count at or above which clearing triggers. */
  trigger: number
  /** How many recent tool uses to keep uncleared. */
  keep: number
  /** Minimum input tokens to clear, so a cache rewrite is worth it. */
  clearAtLeast: number
  /** Tool names never cleared. */
  excludeTools?: string[]
}

export const DEFAULT_CONTEXT_EDITING: ContextEditingSettings = {
  trigger: 150_000,
  keep: 6,
  clearAtLeast: 40_000,
}

/**
 * Turn the config union (false | true | partial object) into resolved settings,
 * or null when disabled. `true` means "on with every default".
 */
export function resolveContextEditing(
  cfg: ClaudeAuthConfig,
): ContextEditingSettings | null {
  const raw = cfg.contextEditing
  if (raw === false || raw === undefined) return null
  if (raw === true) return { ...DEFAULT_CONTEXT_EDITING }
  const out: ContextEditingSettings = {
    trigger: raw.trigger ?? DEFAULT_CONTEXT_EDITING.trigger,
    keep: raw.keep ?? DEFAULT_CONTEXT_EDITING.keep,
    clearAtLeast: raw.clearAtLeast ?? DEFAULT_CONTEXT_EDITING.clearAtLeast,
  }
  if (raw.excludeTools && raw.excludeTools.length > 0) {
    out.excludeTools = raw.excludeTools
  }
  return out
}

type MessageBody = {
  tools?: unknown
  // eslint-disable-next-line @typescript-eslint/naming-convention
  context_management?: unknown
} & Record<string, unknown>

/**
 * Add a `context_management` block to a `/v1/messages` body, or leave it alone.
 *
 * Returns `changed: false` (and the body untouched) when editing is disabled,
 * the body is not a parseable object, it carries no tools (nothing to clear),
 * or the client already sent its own `context_management` — an explicit one
 * from the caller always wins over this default.
 */
export function applyContextEditing(
  body: unknown,
  settings: ContextEditingSettings | null,
): { body: unknown; changed: boolean } {
  if (!settings) return { body, changed: false }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { body, changed: false }
  }
  const b = body as MessageBody
  if (!Array.isArray(b.tools) || b.tools.length === 0) {
    return { body, changed: false }
  }
  if (b.context_management !== undefined) return { body, changed: false }

  const edit: Record<string, unknown> = {
    type: "clear_tool_uses_20250919",
    trigger: { type: "input_tokens", value: settings.trigger },
    keep: { type: "tool_uses", value: settings.keep },
    clear_at_least: { type: "input_tokens", value: settings.clearAtLeast },
  }
  if (settings.excludeTools && settings.excludeTools.length > 0) {
    edit.exclude_tools = settings.excludeTools
  }

  return {
    body: { ...b, context_management: { edits: [edit] } },
    changed: true,
  }
}

/**
 * Does this 400 body say the server rejected context editing itself?
 *
 * The recovery is to disable editing for the process and retry without it, so
 * this must fire only on a complaint about the feature — not on any 400 that
 * happens to arrive while editing is on.
 */
export function contextEditDisabledBy400(responseBody: string): boolean {
  // Judge the error message, not the whole body: a 400 that merely echoes the
  // field elsewhere must not switch editing off for the whole process.
  let text = responseBody
  try {
    const parsed = JSON.parse(responseBody) as { error?: { message?: unknown } }
    if (parsed && typeof parsed === "object")
      text =
        typeof parsed.error?.message === "string" ? parsed.error.message : ""
  } catch {}
  return (
    text.includes("context_management") ||
    text.includes("context-management-2025-06-27")
  )
}

/**
 * The edits the server reports it actually applied, if the response echoes a
 * `context_management.applied_edits` block, with the cleared input-token count
 * summed. Returns null when nothing was applied or the shape is absent.
 */
export function clearedInputTokens(response: unknown): number | null {
  if (!response || typeof response !== "object") return null
  const cm = (response as { context_management?: unknown }).context_management
  if (!cm || typeof cm !== "object") return null
  const edits = (cm as { applied_edits?: unknown }).applied_edits
  if (!Array.isArray(edits) || edits.length === 0) return null
  let cleared = 0
  let seen = false
  for (const e of edits) {
    if (!e || typeof e !== "object") continue
    const n = (e as { cleared_input_tokens?: unknown }).cleared_input_tokens
    if (typeof n === "number" && Number.isFinite(n)) {
      cleared += n
      seen = true
    }
  }
  return seen ? cleared : null
}
