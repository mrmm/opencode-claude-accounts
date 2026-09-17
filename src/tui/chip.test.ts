import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  buildPickerOptions,
  formatChip,
  shortLabel,
  shortNames,
  teamName,
  accountHealth,
  approxTokens,
  contextSummary,
  detailRows,
  fmtBytes,
  accountToggleRows,
  quotaText,
  SEP,
  ago,
  enabledSources,
  toggleAccount,
  sessionRows,
  shortModel,
  sidebarLines,
  mostRecentlyObserved,
  utilisation,
  type ChipAccount,
} from "./chip.ts"
import type { QuotaCache } from "../balance/index.ts"

const ACCOUNTS: ChipAccount[] = [
  { source: "s1", label: "Claude Team - Team A - Wings of Freedom" },
  { source: "s2", label: "Claude Team - Team B - Survey Corps" },
]

const q = (
  five?: number,
  week?: number,
  rejected = false,
): QuotaCache[string] =>
  ({
    ...(five === undefined
      ? {}
      : {
          fiveHour: {
            utilization: five,
            resetsAt: 0,
            status: rejected ? "rejected" : "allowed",
          },
        }),
    ...(week === undefined
      ? {}
      : { sevenDay: { utilization: week, resetsAt: 0, status: "allowed" } }),
    observedAt: 0,
  }) as QuotaCache[string]

describe("shortLabel", () => {
  it("keeps the part that distinguishes accounts, not the shared prefix", () => {
    assert.equal(
      shortLabel("Claude Team - Team A - Wings of Freedom"),
      "Wings of Freedom",
    )
  })

  it("falls back to stripping the vendor prefix when there is no separator", () => {
    assert.equal(shortLabel("Claude Code credentials"), "credentials")
  })

  it("never returns empty, whatever it is handed", () => {
    for (const input of ["Claude Team", "-", " ", "x"]) {
      assert.ok(
        shortLabel(input).length > 0,
        `empty for ${JSON.stringify(input)}`,
      )
    }
  })
})

describe("utilisation", () => {
  it("reports whole percents for both windows", () => {
    const u = utilisation({ s1: q(0.414, 0.45) } as QuotaCache, "s1")
    assert.deepEqual([u.five, u.week], [41, 45])
  })

  it("distinguishes 'not observed' from zero", () => {
    const u = utilisation({} as QuotaCache, "s1")
    assert.equal(u.five, undefined)
    const z = utilisation({ s1: q(0, 0) } as QuotaCache, "s1")
    assert.equal(z.five, 0, "0% is a reading, not a missing reading")
  })

  it("flags a rejected window", () => {
    assert.equal(
      utilisation({ s1: q(1, 0.3, true) } as QuotaCache, "s1").rejected,
      true,
    )
    assert.equal(
      utilisation({ s1: q(1, 0.3) } as QuotaCache, "s1").rejected,
      false,
    )
  })
})

describe("formatChip", () => {
  const base = {
    accounts: ACCOUNTS,
    quota: { s1: q(0.41, 0.45) } as QuotaCache,
  }

  it("names the account serving and its 5h window, labelled", () => {
    // Only the 5h window here: it is the one that moves during a session, and
    // this sits beside the prompt. The weekly figure is in the sidebar, which
    // has a column to spend on it.
    const chip = formatChip({
      ...base,
      selection: "preset:rr-123",
      activeSource: "s1",
    })
    assert.match(chip, /Wings of Freedom/)
    assert.match(chip, /5h 41%/)
    assert.ok(
      !chip.includes("45%"),
      "the weekly window does not belong beside the prompt",
    )
  })

  it("shows which preset is balancing, so the mode is never a guess", () => {
    assert.match(
      formatChip({ ...base, selection: "preset:rr-123", activeSource: "s1" }),
      /rr-123/,
    )
    assert.match(
      formatChip({ ...base, selection: "__auto__", activeSource: "s1" }),
      /auto/,
    )
  })

  it("marks a pin differently from balancing", () => {
    const pinned = formatChip({ ...base, selection: "s1", activeSource: "s1" })
    assert.ok(
      !pinned.includes("⇄"),
      "a pin is not balancing and must not claim to be",
    )
  })

  it("says so when no account is serving", () => {
    assert.match(
      formatChip({ ...base, selection: "__auto__", activeSource: null }),
      /no account/,
    )
  })

  it("stays short enough to sit beside the prompt", () => {
    const chip = formatChip({
      ...base,
      selection: "preset:rr-123",
      activeSource: "s1",
    })
    assert.ok(chip.length <= 40, `chip too wide: ${chip.length} cols - ${chip}`)
  })

  it("says a rejected account is refused, in a word", () => {
    // "!" needed a legend. This is the one state meaning requests fail now.
    const chip = formatChip({
      accounts: ACCOUNTS,
      quota: { s1: q(1, 0.3, true) } as QuotaCache,
      selection: "__auto__",
      activeSource: "s1",
    })
    assert.match(chip, /refused/)
  })
})

describe("buildPickerOptions", () => {
  const input = {
    accounts: ACCOUNTS,
    presets: { "rr-123": { label: "LB round-robin", strategy: "round-robin" } },
    quota: { s1: q(0.41, 0.45) } as QuotaCache,
    selection: "preset:rr-123",
  }

  it("offers presets, Auto and every account", () => {
    const rows = buildPickerOptions(input)
    assert.equal(rows.length, 1 + 1 + ACCOUNTS.length)
    assert.deepEqual(
      rows.map((r) => r.value),
      ["preset:rr-123", "__auto__", "s1", "s2"],
    )
  })

  it("shapes rows as the host DialogSelect expects", () => {
    // The host requires `title`; a row built with `label` type-checks nowhere
    // and renders as an empty line.
    for (const row of buildPickerOptions(input)) {
      assert.equal(typeof row.title, "string")
      assert.ok(row.title.length > 0)
      assert.equal(typeof row.value, "string")
    }
  })

  it("marks only the current selection as active", () => {
    const rows = buildPickerOptions(input)
    assert.deepEqual(
      rows.filter((r) => r.description === "active").map((r) => r.value),
      ["preset:rr-123"],
    )
  })

  it("writes a value the selection file understands", () => {
    // These are exactly the three shapes rotate.ts resolves; a row whose value
    // is a display string would silently select nothing.
    for (const row of buildPickerOptions(input)) {
      assert.ok(
        row.value === "__auto__" ||
          row.value.startsWith("preset:") ||
          ACCOUNTS.some((a) => a.source === row.value),
        `row value is not a selection: ${row.value}`,
      )
    }
  })

  it("shows quota per account where it is known", () => {
    const rows = buildPickerOptions(input)
    assert.match(rows.find((r) => r.value === "s1")!.title, /41%/)
    assert.ok(!rows.find((r) => r.value === "s2")!.title.includes("%"))
  })
})

describe("mostRecentlyObserved", () => {
  it("picks the account that served most recently", () => {
    const cache = {
      s1: { observedAt: 100 },
      s2: { observedAt: 300 },
      s3: { observedAt: 200 },
    } as unknown as QuotaCache
    assert.equal(mostRecentlyObserved(cache), "s2")
  })

  it("answers null rather than guessing when the cache is empty", () => {
    assert.equal(mostRecentlyObserved({} as QuotaCache), null)
    assert.equal(mostRecentlyObserved(undefined as unknown as QuotaCache), null)
  })

  it("ignores entries with no timestamp instead of ranking them first", () => {
    const cache = { s1: {}, s2: { observedAt: 5 } } as unknown as QuotaCache
    assert.equal(mostRecentlyObserved(cache), "s2")
  })
})

describe("sidebarLines", () => {
  const base = {
    accounts: ACCOUNTS,
    quota: { s1: q(0.41, 0.45) } as QuotaCache,
    activeSource: "s1",
  }

  it("names the mode in the heading", () => {
    assert.match(
      sidebarLines({ ...base, selection: "preset:rr-123" }).heading,
      /rr-123/,
    )
    assert.match(
      sidebarLines({ ...base, selection: "__auto__" }).heading,
      /auto/,
    )
    assert.equal(sidebarLines({ ...base, selection: "s1" }).heading, "pinned")
  })

  it("lists every account, marking the one serving", () => {
    const { rows } = sidebarLines({ ...base, selection: "__auto__" })
    assert.equal(rows.length, ACCOUNTS.length)
    assert.deepEqual(
      rows.map((r) => r.active),
      [true, false],
    )
  })

  it("says so when an account has no reading, rather than implying 0%", () => {
    const { rows } = sidebarLines({ ...base, selection: "__auto__" })
    assert.match(rows[0]!.detail, /5h 41%/)
    assert.match(rows[0]!.detail, /wk 45%/)
    assert.match(rows[1]!.detail, /no reading/)
  })

  it("shows each account's share of requests when it is known", () => {
    const { rows } = sidebarLines({
      ...base,
      selection: "__auto__",
      requests: { s1: 75, s2: 25 },
    })
    assert.match(rows[0]!.detail, /75% reqs/)
    assert.match(rows[1]!.detail, /25% reqs/)
  })

  it("omits the share rather than printing 0% when nothing is known", () => {
    const { rows } = sidebarLines({ ...base, selection: "__auto__" })
    assert.ok(!rows[0]!.detail.includes("reqs"))
    const zero = sidebarLines({ ...base, selection: "__auto__", requests: {} })
    assert.ok(!zero.rows[0]!.detail.includes("reqs"))
  })

  it("says how many accounts are excluded, rather than just omitting them", () => {
    // An account missing from a list of accounts is otherwise indistinguishable
    // from one the plugin failed to see.
    const { heading } = sidebarLines({
      ...base,
      selection: "preset:rr-123",
      hiddenCount: 2,
    })
    assert.match(heading, /rr-123/)
    assert.match(heading, /2 off/)
  })

  it("stays quiet when nothing is excluded", () => {
    const { heading } = sidebarLines({ ...base, selection: "__auto__" })
    assert.ok(!heading.includes("off"))
    assert.ok(
      !sidebarLines({
        ...base,
        selection: "__auto__",
        hiddenCount: 0,
      }).heading.includes("off"),
    )
  })

  it("renders with no accounts at all instead of throwing", () => {
    const { rows, heading } = sidebarLines({
      accounts: [],
      quota: {} as QuotaCache,
      selection: "__auto__",
      activeSource: null,
    })
    assert.equal(rows.length, 0)
    assert.ok(heading.length > 0)
  })
})

const sess = (over = {}) => ({
  session: "ses_f55334270ffegZH7CzDNqTc4iN",
  requests: 12,
  errors: 0,
  accounts: ["a1"],
  models: ["claude-opus-5"],
  avg_ms: 2400,
  first_at: 0,
  last_at: 1_000_000,
  ...over,
})

describe("sessionRows", () => {
  it("leads with the distinguishing tail of the id and the request count", () => {
    const [row] = sessionRows([sess()], 1_000_000)
    assert.match(row!.title, /DNqTc4iN/)
    assert.match(row!.title, /12 req/)
  })

  it("mentions errors only when there are some", () => {
    assert.ok(!sessionRows([sess()], 1_000_000)[0]!.title.includes("err"))
    assert.match(
      sessionRows([sess({ errors: 3 })], 1_000_000)[0]!.title,
      /3 err/,
    )
  })

  it("says how many accounts served the session", () => {
    assert.match(sessionRows([sess()], 1_000_000)[0]!.description!, /1 account/)
    assert.match(
      sessionRows([sess({ accounts: ["a1", "a2", "a3"] })], 1_000_000)[0]!
        .description!,
      /3 accounts/,
    )
  })

  it("keeps the value addressable as the session id", () => {
    assert.equal(sessionRows([sess()], 1_000_000)[0]!.value, sess().session)
  })

  it("renders an empty log as no rows, not a placeholder row", () => {
    assert.deepEqual(sessionRows([], 1_000_000), [])
  })
})

describe("ago / shortModel", () => {
  it("scales the unit to the distance", () => {
    const now = 1_000_000_000
    assert.equal(ago(now - 5_000, now), "5s ago")
    assert.equal(ago(now - 120_000, now), "2m ago")
    assert.equal(ago(now - 7_200_000, now), "2h ago")
    assert.equal(ago(now - 172_800_000, now), "2d ago")
  })

  it("never reports a negative age from a clock skew", () => {
    assert.equal(ago(1_000, 0), "0s ago")
  })

  it("drops the prefix every model shares", () => {
    assert.equal(shortModel("claude-opus-5"), "opus-5")
    assert.equal(shortModel("gpt-4"), "gpt-4")
  })
})

describe("teamName / shortNames", () => {
  it("takes the last number, not the one in the vendor prefix", () => {
    // "Claude Team - Acme 3 - Nickname": the word Team comes early, the index
    // that identifies the account comes later.
    assert.equal(teamName("Claude Team - Acme 3 - Scouting Legion"), "Team 3")
    assert.equal(teamName("Claude Team 2: someone@example.com"), "Team 2")
  })

  it("answers null when there is no number to use", () => {
    assert.equal(teamName("Claude Code credentials"), null)
  })

  it("names each account by its number when those are unique", () => {
    const names = shortNames([
      { source: "s1", label: "Claude Team - Acme 1 - Wings" },
      { source: "s2", label: "Claude Team - Acme 2 - Survey" },
      { source: "s3", label: "Claude Team - Acme 3 - Scouting" },
    ])
    assert.deepEqual(
      [names.get("s1"), names.get("s2"), names.get("s3")],
      ["Team 1", "Team 2", "Team 3"],
    )
  })

  it("refuses to give two accounts the same short name", () => {
    // Both end in 1. Calling both "Team 1" would make the sidebar lie about
    // which account is serving, so both keep their distinguishing name.
    const names = shortNames([
      { source: "s1", label: "Claude Team 1: someone@example.com" },
      { source: "s2", label: "Claude Team - Acme 1 - Wings of Freedom" },
    ])
    assert.notEqual(names.get("s1"), names.get("s2"))
    assert.ok(!names.get("s2")!.startsWith("Team 1"))
  })

  it("falls back for an account with no number, leaving the others short", () => {
    const names = shortNames([
      { source: "s1", label: "Claude Code credentials" },
      { source: "s2", label: "Claude Team - Acme 2 - Survey" },
    ])
    assert.equal(names.get("s1"), "credentials")
    assert.equal(names.get("s2"), "Team 2")
  })

  it("gives every account a non-empty name", () => {
    const names = shortNames([
      { source: "s1", label: "" },
      { source: "s2", label: "Team" },
    ])
    for (const v of names.values()) assert.ok(v.length > 0)
  })
})

describe("account allow-list", () => {
  const ALL: ChipAccount[] = [
    { source: "s1", label: "Claude Team - Acme 1 - Wings" },
    { source: "s2", label: "Claude Team - Acme 2 - Survey" },
    { source: "s3", label: "Claude Team - Acme 3 - Scouting" },
  ]

  it("reads an empty list as every account, not none", () => {
    assert.deepEqual(enabledSources(ALL, []), ["s1", "s2", "s3"])
  })

  it("ignores an entry for an account that no longer exists", () => {
    assert.deepEqual(enabledSources(ALL, ["s2", "gone"]), ["s2"])
  })

  it("falls back to everything when the list matches nothing", () => {
    // Mirrors the config's own rule: a stale list must not strand the plugin.
    assert.deepEqual(enabledSources(ALL, ["gone"]), ["s1", "s2", "s3"])
  })

  it("excludes one account by listing the others", () => {
    assert.deepEqual(toggleAccount(ALL, [], "s1"), ["s2", "s3"])
  })

  it("re-enabling everything writes the empty list, not all three", () => {
    // [] is how the config spells "all". Writing the three explicitly would
    // pin the set, so an account added later would arrive disabled.
    assert.deepEqual(toggleAccount(ALL, ["s2", "s3"], "s1"), [])
  })

  it("refuses to disable the last one", () => {
    // An empty allow-list means "all", so removing the final entry would
    // silently re-enable everything -- the opposite of what was asked.
    assert.equal(toggleAccount(ALL, ["s2"], "s2"), null)
  })

  it("keeps preference order rather than click order", () => {
    assert.deepEqual(toggleAccount(ALL, ["s3"], "s1"), ["s1", "s3"])
  })

  it("marks each row with its state and short name", () => {
    const rows = accountToggleRows(ALL, ["s2", "s3"], {} as QuotaCache)
    assert.match(rows[0]!.title, /^\[ \] Team 1/)
    assert.match(rows[1]!.title, /^\[x\] Team 2/)
  })

  it("says when an account is being refused, not just its quota", () => {
    const rows = accountToggleRows(ALL, [], {
      s1: q(1, 0.3, true),
    } as QuotaCache)
    assert.match(rows[0]!.description, /refused/)
  })
})

describe("display vocabulary", () => {
  it("labels both windows, because 13%/56% never said which was which", () => {
    const text = quotaText({ s1: q(0.13, 0.56) } as QuotaCache, "s1")
    assert.match(text, /5h 13%/)
    assert.match(text, /wk 56%/)
    assert.ok(!text.includes("/"), "a slash does not say which window is which")
  })

  it("can omit the weekly window where there is no room", () => {
    const text = quotaText({ s1: q(0.13, 0.56) } as QuotaCache, "s1", {
      includeWeek: false,
    })
    assert.match(text, /5h 13%/)
    assert.ok(!text.includes("wk"))
  })

  it("distinguishes a missing window from a zero one", () => {
    assert.match(quotaText({ s1: q(0.13) } as QuotaCache, "s1"), /wk \u2014/)
    assert.match(quotaText({ s1: q(0.13, 0) } as QuotaCache, "s1"), /wk 0%/)
  })

  it("says no reading when neither window was observed", () => {
    assert.equal(quotaText({} as QuotaCache, "s1"), "no reading")
  })

  it("leads with refused, since that outranks any percentage", () => {
    const text = quotaText({ s1: q(1.04, 0.57, true) } as QuotaCache, "s1")
    assert.ok(text.startsWith("refused"), text)
    assert.match(text, /5h 104%/, "over 100% is a real reading, not a bug")
  })

  it("separates fields with something that cannot occur inside one", () => {
    // Hyphens appear in model names, preset names and account labels, which is
    // why they cannot also be the separator.
    assert.equal(SEP.trim(), "\u00b7")
    for (const value of ["haiku-4-5", "rr-123", "Wings of Freedom"]) {
      assert.ok(!value.includes(SEP.trim()), `${value} contains the separator`)
    }
  })
})

describe("accountHealth", () => {
  const TH = { warnAt: 0.9, weeklyWarnAt: 0.85 }

  it("is unknown when nothing has been observed", () => {
    assert.equal(accountHealth({} as QuotaCache, "s1", TH), "unknown")
  })

  it("is ok well below the thresholds", () => {
    assert.equal(
      accountHealth({ s1: q(0.2, 0.3) } as QuotaCache, "s1", TH),
      "ok",
    )
  })

  it("warns from the configured threshold, not a number of its own", () => {
    // The colouring has to agree with the figure the plugin would warn about,
    // or the sidebar is a second opinion that quietly disagrees with the toast.
    assert.equal(
      accountHealth({ s1: q(0.89, 0.1) } as QuotaCache, "s1", TH),
      "ok",
    )
    assert.equal(
      accountHealth({ s1: q(0.9, 0.1) } as QuotaCache, "s1", TH),
      "warn",
    )
    assert.equal(
      accountHealth({ s1: q(0.89, 0.1) } as QuotaCache, "s1", {
        warnAt: 0.5,
        weeklyWarnAt: 0.85,
      }),
      "warn",
      "a lower configured threshold must colour sooner",
    )
  })

  it("warns on the weekly window too, not only the 5h one", () => {
    assert.equal(
      accountHealth({ s1: q(0.1, 0.9) } as QuotaCache, "s1", TH),
      "warn",
    )
  })

  it("is critical at the window itself, not merely past the warning line", () => {
    assert.equal(
      accountHealth({ s1: q(1, 0.1) } as QuotaCache, "s1", TH),
      "critical",
    )
    assert.equal(
      accountHealth({ s1: q(1.04, 0.5) } as QuotaCache, "s1", TH),
      "critical",
    )
  })

  it("treats being refused as critical whatever the numbers say", () => {
    // Refused outranks any reading: requests are failing right now.
    assert.equal(
      accountHealth({ s1: q(0.1, 0.1, true) } as QuotaCache, "s1", TH),
      "critical",
    )
  })

  it("gives the sidebar a health per row, distinct from which one is serving", () => {
    // The old rendering coloured by "is it serving", so a healthy idle account
    // and an exhausted idle account looked the same -- the one comparison this
    // list exists to support.
    const { rows } = sidebarLines({
      accounts: ACCOUNTS,
      quota: { s1: q(0.2, 0.2), s2: q(1.04, 0.9, true) } as QuotaCache,
      selection: "__auto__",
      activeSource: "s1",
      thresholds: TH,
    })
    assert.deepEqual(
      rows.map((r) => [r.active, r.health]),
      [
        [true, "ok"],
        [false, "critical"],
      ],
    )
  })
})

const DETAIL = {
  session: "ses_abc",
  requests: 10,
  errors: 2,
  byStatus: [
    { status: 200, count: 8 },
    { status: 429, count: 2 },
  ],
  byAccount: [
    { account: "s1", requests: 7 },
    { account: "s2", requests: 3 },
  ],
  byModel: [{ model: "claude-opus-5", requests: 10 }],
  avg_ms: 2400,
  max_ms: 9100,
  first_at: 0,
  last_at: 600_000,
  quotaMoves: [{ account: "s1", from: 0.2, to: 0.35 }],
}

describe("fmtBytes / approxTokens", () => {
  it("scales the unit", () => {
    assert.equal(fmtBytes(512), "512 B")
    assert.equal(fmtBytes(2048), "2 KB")
    assert.equal(fmtBytes(2_097_152), "2.0 MB")
  })

  it("marks a token count as the estimate it is", () => {
    // Four bytes per token is a rule of thumb that holds badly for code and
    // JSON, which is most of a system prompt. The tilde is not decoration.
    assert.match(approxTokens(40_000), /^~/)
    assert.equal(approxTokens(40_000), "~10k tok")
    assert.equal(approxTokens(400), "~100 tok")
  })
})

const shape = (bytes: number) => ({
  bytes,
  systemBytes: 100,
  toolBytes: 200,
  messageBytes: bytes - 300,
  cachedBytes: 50,
})

describe("contextSummary", () => {
  it("answers null when nothing was captured", () => {
    assert.equal(contextSummary([]), null)
  })

  it("averages rather than sums, since the question is request size", () => {
    const c = contextSummary([shape(1000), shape(3000)])!
    assert.equal(c.avgBytes, 2000)
    assert.equal(c.maxBytes, 3000)
    assert.equal(c.systemBytes, 100, "system is per-request, not cumulative")
    assert.equal(c.captured, 2)
  })
})

describe("detailRows", () => {
  it("groups the report into sections", () => {
    const sections = [
      ...new Set(detailRows(DETAIL, { now: 600_000 }).map((r) => r.category)),
    ]
    assert.deepEqual(sections, [
      "Traffic",
      "Accounts",
      "Models",
      "Quota (5h)",
      "Context",
    ])
  })

  it("reports rate as well as count", () => {
    const rows = detailRows(DETAIL, { now: 600_000 })
    const traffic = rows.find((r) => r.title === "10 requests")!
    assert.match(traffic.description, /10m/)
    assert.match(traffic.description, /1\.0\/min/)
  })

  it("breaks failures down by status instead of just counting them", () => {
    const rows = detailRows(DETAIL, { now: 600_000 })
    assert.match(
      rows.find((r) => r.title === "2 failed")!.description,
      /2x 429/,
    )
  })

  it("says nothing about failures when there were none", () => {
    const rows = detailRows({ ...DETAIL, errors: 0 }, { now: 600_000 })
    assert.ok(!rows.some((r) => r.title.includes("failed")))
  })

  it("reports the slowest request, not only the average", () => {
    const rows = detailRows(DETAIL, { now: 600_000 })
    assert.match(
      rows.find((r) => r.title.startsWith("avg"))!.description,
      /9\.1s/,
    )
  })

  it("uses the short account names the rest of the UI uses", () => {
    const names = new Map([["s1", "Team 1"]])
    const rows = detailRows(DETAIL, { names, now: 600_000 })
    assert.ok(
      rows.some((r) => r.title === "Team 1" && r.category === "Accounts"),
    )
  })

  it("states that quota movement is shared, not attributed", () => {
    // The 5h window is consumed by every session at once, so this is an upper
    // bound. Presenting it as this session's cost would be a lie.
    const row = detailRows(DETAIL, { now: 600_000 }).find(
      (r) => r.category === "Quota (5h)",
    )!
    assert.match(row.title, /20% -> 35%/)
    assert.match(row.description, /shared/)
  })

  it("explains how to get context rather than showing a blank section", () => {
    const row = detailRows(DETAIL, { now: 600_000 }).find(
      (r) => r.category === "Context",
    )!
    assert.match(row.title, /not recorded/)
    assert.match(row.description, /captureRequests/)
  })

  it("reports context when it was captured, marking the fixed overhead", () => {
    const context = contextSummary([
      {
        bytes: 40_000,
        systemBytes: 8_000,
        toolBytes: 12_000,
        messageBytes: 20_000,
        cachedBytes: 6_000,
      },
    ])
    const rows = detailRows(DETAIL, { context, now: 600_000 }).filter(
      (r) => r.category === "Context",
    )
    assert.match(rows[0]!.title, /avg 39 KB/)
    assert.ok(
      rows.some(
        (r) =>
          r.title.startsWith("system") &&
          r.description.includes("every request"),
      ),
      "system cost is paid per request and must say so",
    )
    assert.ok(rows.some((r) => r.title.startsWith("cached")))
  })
})
