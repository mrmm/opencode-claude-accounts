/**
 * The outgoing request body, parsed once.
 *
 * Three rewrites apply to a Messages body -- the Claude Code shape
 * (`transformParsed`), the cache TTL and context editing -- and each used to
 * parse and re-serialise the whole JSON, a cost that grows with the
 * conversation and is paid on every turn. Here they share one parse and the
 * request body is serialised once. The un-edited form, needed only if the
 * server refuses context editing, is serialised on demand.
 */
import {
  type ContextEditingSettings,
  type ResolvedTtl,
  applyContextEditing,
  setCacheTtl,
} from "./balance/index.ts"
import { type TransformTarget, transformParsed } from "./transforms.ts"

export type PreparedBody = {
  body: BodyInit | null | undefined
  /** The same request without context editing, for the 400 retry. */
  withoutEditing: () => BodyInit | null | undefined
  contextEdited: boolean
  /** Whether any cache_control marker carries the requested ttl. */
  ttlSet: boolean
  /** The parsed object `body` was serialised from, for read-only callers. */
  sent?: object
}

export function prepareBody(
  raw: BodyInit | null | undefined,
  parsed: unknown,
  opts: { ttl?: ResolvedTtl; contextEditing?: ContextEditingSettings | null },
): PreparedBody {
  const unchanged: PreparedBody = {
    body: raw,
    withoutEditing: () => raw,
    contextEdited: false,
    ttlSet: false,
  }
  if (typeof raw !== "string" || !parsed || typeof parsed !== "object")
    return unchanged
  try {
    transformParsed(parsed as TransformTarget)
  } catch {
    return unchanged
  }
  const ttlSet = opts.ttl ? setCacheTtl(parsed, opts.ttl) : false
  // applyContextEditing copies rather than mutates, so `parsed` stays the
  // un-edited request for the retry.
  const edited = applyContextEditing(parsed, opts.contextEditing ?? null)
  if (!edited.changed) {
    const plain = JSON.stringify(parsed)
    return {
      body: plain,
      withoutEditing: () => plain,
      contextEdited: false,
      ttlSet,
      sent: parsed,
    }
  }
  return {
    body: JSON.stringify(edited.body),
    withoutEditing: () => JSON.stringify(parsed),
    contextEdited: true,
    ttlSet,
    sent: edited.body as object,
  }
}
