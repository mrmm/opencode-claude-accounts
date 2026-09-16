import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  buildPickerOptions,
  formatChip,
  shortLabel,
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

  it("names the account actually serving, with both windows", () => {
    const chip = formatChip({
      ...base,
      selection: "preset:rr-123",
      activeSource: "s1",
    })
    assert.match(chip, /Wings of Freedom/)
    assert.match(chip, /41%\/45%/)
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
    assert.ok(chip.length <= 34, `chip too wide: ${chip.length} cols — ${chip}`)
  })

  it("marks a rejected account", () => {
    const chip = formatChip({
      accounts: ACCOUNTS,
      quota: { s1: q(1, 0.3, true) } as QuotaCache,
      selection: "__auto__",
      activeSource: "s1",
    })
    assert.match(chip, /!/)
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

  it("marks only the current selection as active", () => {
    const rows = buildPickerOptions(input)
    assert.deepEqual(
      rows.filter((r) => r.hint === "active").map((r) => r.value),
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
    assert.match(rows.find((r) => r.value === "s1")!.label, /41%/)
    assert.ok(!rows.find((r) => r.value === "s2")!.label.includes("%"))
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
