/**
 * Usage ceilings: how full an account is allowed to get before it is held in
 * reserve.
 *
 * `switchAt` already moves the balancer off a busy account onto an emptier one.
 * A ceiling is the stronger statement -- past it, the account is not merely
 * passed over, it is reserved: kept back for when every other account is spent
 * too, and only spent then if the mode and the session allow it. The effective
 * limit the balancer acts on is therefore the LOWER of `switchAt` and the
 * ceiling, so a ceiling can only ever tighten, never loosen, when an account is
 * abandoned.
 *
 * Pure: every function reads only the config it is handed. The per-account
 * ceilings live on `cfg.accountIds[id].maxUsage`, where a preset override has
 * already been folded in by `resolveActiveConfig`, so this module never has to
 * know a preset exists.
 */

import type { ClaudeAuthConfig } from "../config.ts"

export type CapWindow = "5h" | "7d"

/**
 * The ceiling for an account on one window, as a ratio 0..1. 1 means no
 * ceiling -- the account may run to its full allowance before being reserved.
 */
export function ceilingFor(
  cfg: Pick<ClaudeAuthConfig, "accountIds">,
  id: string,
  window: CapWindow,
): number {
  const max = cfg.accountIds[id]?.maxUsage?.[window]
  return max === undefined || max <= 0 || max > 1 ? 1 : max
}

/**
 * The utilisation at which this account stops being freely available: the lower
 * of `switchAt` and the window's ceiling. At or above it the account is over
 * threshold; at or above the ceiling specifically it is reserved.
 */
export function effectiveLimit(
  cfg: Pick<ClaudeAuthConfig, "accountIds" | "switchAt">,
  id: string,
  window: CapWindow,
): number {
  return Math.min(cfg.switchAt, ceilingFor(cfg, id, window))
}
