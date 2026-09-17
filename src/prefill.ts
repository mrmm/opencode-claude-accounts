/**
 * Recovering from "this model does not support assistant message prefill".
 *
 * Anthropic accepts a trailing assistant message as a *prefill*: the model
 * continues that text instead of starting fresh. Some models refuse it and
 * answer 400 "The conversation must end with a user message." OpenCode sends
 * one when a turn was interrupted, so the next request inherits the partial
 * assistant message and the session wedges -- every retry rebuilds the same
 * body and fails identically.
 *
 * The recovery is to drop the trailing assistant turn and send again. That is
 * lossy, which is why it is opt-in (`retryPrefillError`) and why it happens
 * only in response to the specific 400 rather than on every request: a body
 * that the model accepts is never touched.
 */

/** Does this response body carry the prefill refusal? */
export function isPrefillError(responseBody: string): boolean {
  // Matched on the stable clause rather than the whole sentence, which has
  // varied ("must end with a user message" / "must end with a `user` message").
  return responseBody.includes("does not support assistant message prefill")
}

type Message = { role?: unknown }

/**
 * The same body with trailing assistant messages removed, or null when there is
 * nothing safe to do.
 *
 * Returns null -- rather than a mangled body -- when the payload will not parse,
 * carries no message array, does not actually end with an assistant turn, or
 * consists only of assistant turns. The last case matters: stripping it would
 * send an empty conversation, trading a clear 400 for a confusing one.
 */
export function stripTrailingAssistant(body: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null

  const payload = parsed as { messages?: unknown }
  if (!Array.isArray(payload.messages)) return null

  const messages = payload.messages as Message[]
  if (messages.length === 0) return null
  if (messages[messages.length - 1]?.role !== "assistant") return null

  let end = messages.length
  while (end > 0 && messages[end - 1]?.role === "assistant") end--
  if (end === 0) return null

  return JSON.stringify({ ...payload, messages: messages.slice(0, end) })
}
