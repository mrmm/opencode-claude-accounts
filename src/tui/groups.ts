/**
 * The sidebar's account list, split by configured group.
 *
 * Pure: the caller passes the visible accounts (already in configured order),
 * the quota cache, request counts keyed by source, and a resolver from config
 * reference to source. Quota is read through `utilisation`, which goes through
 * `quotaEntry`, so an id-keyed cache entry is found from a source.
 */
import type { AccountGroup } from "../config.ts"
import type { QuotaCache } from "../balance/index.ts"
import {
  accountHealth,
  windowCell,
  servedBy,
  utilisation,
  type ChipAccount,
  type Health,
} from "./chip.ts"

export type GroupSection = {
  /** Fold key, stable across renders. */
  key: string
  title: string
  /** `5h ▁▁▁ 3%    wk ███ 70%`: the group's use per window, in the account columns. */
  summary: string
  /** `1/3`: accounts that can still take a request, of all members. */
  count: string
  /** `41% reqs`, or empty when nothing was served. */
  share: string
  /** The worst state of any member. */
  health: Health
  /** Members, in configured account order. */
  sources: string[]
}

const RANK: Record<Health, number> = {
  unknown: 0,
  ok: 1,
  paid: 2,
  warn: 3,
  critical: 4,
}

export const OTHER_GROUP = "Other"

/** `Main - Team 1` under `Main` reads `Team 1`; the group already says Main. */
export function memberName(groupTitle: string, name: string): string {
  const prefix = name.slice(0, groupTitle.length)
  if (prefix.toLowerCase() !== groupTitle.toLowerCase()) return name
  const tail = name.slice(groupTitle.length)
  // Only at a word boundary: "Mainframe" is not a member of "Main".
  if (!/^[\s\-\u2013\u2014:\u00b7]/.test(tail)) return name
  const rest = tail.replace(/^[\s\-\u2013\u2014:\u00b7]+/, "")
  return rest.length > 0 ? rest : name
}

/**
 * One section per group, in config order, then `Other` for accounts in no
 * group. Empty when no groups are configured, so the caller renders the flat
 * list. Room is counted in accounts (1.0 = one account's whole window); an
 * account with no reading counts as no room, since no reading is not good news.
 */
export function groupRows(input: {
  groups: Readonly<Record<string, AccountGroup>>
  accounts: readonly ChipAccount[]
  quota: QuotaCache
  requests?: Record<string, number>
  resolve: (ref: string) => string | undefined
  thresholds?: { warnAt: number; weeklyWarnAt: number }
  now?: number
}): GroupSection[] {
  const names = Object.keys(input.groups)
  if (names.length === 0) return []
  const thresholds = input.thresholds ?? { warnAt: 0.9, weeklyWarnAt: 0.85 }
  const total = Object.values(input.requests ?? {}).reduce((n, r) => n + r, 0)

  const section = (key: string, title: string, sources: string[]) => {
    let five = 0
    let week = 0
    let served = 0
    let usable = 0
    let health: Health = "unknown"
    for (const s of sources) {
      const u = utilisation(input.quota, s, input.now)
      five += u.five === undefined ? 0 : Math.max(0, 1 - u.five / 100)
      week += u.week === undefined ? 0 : Math.max(0, 1 - u.week / 100)
      served += servedBy(input.requests, s) ?? 0
      if (
        u.five !== undefined &&
        u.week !== undefined &&
        u.five < 100 &&
        u.week < 100 &&
        !u.rejected
      )
        usable++
      const h = accountHealth(input.quota, s, thresholds)
      if (RANK[h] > RANK[health]) health = h
    }
    const n = sources.length
    const share = total > 0 ? `${Math.round((served / total) * 100)}% reqs` : ""
    const used = (left: number) => Math.round((1 - left / n) * 100)
    return {
      key,
      title,
      summary:
        `${windowCell("5h", used(five))}  ${windowCell("wk", used(week))}`.trimEnd(),
      count: `${usable}/${n}`,
      share,
      health,
      sources,
    }
  }

  const grouped = new Set<string>()
  const out: GroupSection[] = []
  for (const name of names) {
    const g = input.groups[name]!
    const members = new Set(
      g.accounts.flatMap((ref) => {
        const s = input.resolve(ref)
        return s ? [s] : []
      }),
    )
    const sources = input.accounts
      .map((a) => a.source)
      .filter((s) => members.has(s))
    for (const s of sources) grouped.add(s)
    // An empty group (just created, or all its accounts disabled) has nothing
    // to summarise; "0.0/0 left" would read as a spent group.
    if (sources.length > 0)
      out.push(section(`group:${name}`, g.label ?? name, sources))
  }
  const rest = input.accounts
    .map((a) => a.source)
    .filter((s) => !grouped.has(s))
  if (rest.length > 0) out.push(section("group-other", OTHER_GROUP, rest))
  return out
}
