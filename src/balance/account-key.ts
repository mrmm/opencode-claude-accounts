/**
 * The key telemetry rows are grouped by.
 *
 * Today an account is identified only by its `source` string, so this is the
 * identity function. It exists as the single seam through which every new
 * telemetry store (samples, cache stats) keys its data, so when a stable
 * account ID lands the swap is one line here rather than a grep across modules.
 */
export function accountKey(source: string): string {
  return source
}
