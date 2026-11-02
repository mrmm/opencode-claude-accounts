/**
 * The sidebar's "all spent" line: shown only while no account in the selection
 * can serve, and saying when the first one is back -- the same answer the 429
 * gives, but visible before a request is refused.
 */
import { formatDuration } from "../balance/index.ts"

export function spentBanner(input: {
  anyUsable: boolean
  next?: { name: string; at: number }
  nowMs: number
  clock: (ms: number) => string
}): string | undefined {
  if (input.anyUsable) return undefined
  if (!input.next) return "all spent · no reset time known"
  const wait = Math.ceil((input.next.at - input.nowMs) / 1000)
  return `all spent · next back ${input.next.name} at ${input.clock(input.next.at)} (in ${formatDuration(wait)})`
}
