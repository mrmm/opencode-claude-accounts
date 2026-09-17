import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  configRows,
  display,
  EDITABLE,
  setJsoncValue,
  toLiteral,
  optionsFor,
  validateValue,
} from "./config-edit.ts"
import { DEFAULT_CONFIG, sanitize } from "./config.ts"

const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

describe("EDITABLE", () => {
  it("only offers keys the config actually has", () => {
    const unknown = EDITABLE.filter((e) => !(e.key in DEFAULT_CONFIG))
    assert.deepEqual(
      unknown.map((e) => e.key),
      [],
    )
  })

  it("never offers a key that needs a restart", () => {
    // These are copied into module state by initLogger() or consumed once by a
    // hook, so an editor would appear to work and change nothing until restart.
    const coldKeys = [
      "debug",
      "logLevel",
      "logEvents",
      "logMaxSizeBytes",
      "logKeep",
      "tools",
      "accountLabel",
    ]
    for (const cold of coldKeys) {
      assert.ok(
        !EDITABLE.some((e) => e.key === cold),
        `${cold} is not hot and must not be offered`,
      )
    }
  })

  it("gives every enum its allowed values", () => {
    for (const e of EDITABLE) {
      if (e.kind === "enum") {
        assert.ok((e.options?.length ?? 0) > 1, `${e.key} has no options`)
      }
    }
  })

  it("proposes values the sanitiser accepts", () => {
    // An editor that writes a value sanitize() drops would silently no-op.
    for (const e of EDITABLE) {
      for (const opt of e.options ?? []) {
        const out = sanitize({ [e.key]: opt })
        assert.notEqual(
          out[e.key as keyof typeof out],
          undefined,
          `${e.key}=${opt} was rejected by sanitize`,
        )
      }
    }
  })

  it("gives every typed key an example to show as a placeholder", () => {
    for (const e of EDITABLE) {
      if (e.kind === "number") {
        assert.ok(e.example, `${e.key} is typed but suggests nothing`)
        assert.equal(
          validateValue(e, e.example!).ok,
          true,
          `${e.key}'s own example is rejected`,
        )
      }
    }
  })
})

describe("toLiteral", () => {
  it("writes booleans unquoted", () => {
    assert.equal(toLiteral("boolean", "true"), "true")
    assert.equal(toLiteral("boolean", "false"), "false")
    assert.equal(toLiteral("boolean", "nonsense"), "false")
  })

  it("writes a numeric ratio as a number, not a string", () => {
    assert.equal(toLiteral("text", "0.95"), "0.95")
  })

  it("quotes a duration, which is not a number", () => {
    assert.equal(toLiteral("text", "5m"), '"5m"')
  })

  it("escapes rather than trusting what was typed", () => {
    assert.equal(toLiteral("text", 'a"b'), '"a\\"b"')
  })
})

describe("setJsoncValue", () => {
  const file = `{
  // How the balancer picks.
  "strategy": "sticky",

  /* block comment mentioning "strategy" to be safe */
  "autoSwitch": true,
  "presets": {
    "rr-123": { "strategy": "round-robin" }
  },
  "configReloadInterval": "3s"
}
`

  it("replaces the value and nothing else", () => {
    const out = setJsoncValue(file, "strategy", '"round-robin"')!
    assert.match(out, /"strategy": "round-robin",/)
    assert.ok(out.includes("// How the balancer picks."), "comment lost")
    assert.ok(out.includes("/* block comment"), "block comment lost")
    assert.equal(JSON.parse(strip(out)).strategy, "round-robin")
  })

  it("does not touch the same key nested inside another object", () => {
    const out = setJsoncValue(file, "strategy", '"p2c"')!
    const parsed = JSON.parse(strip(out))
    assert.equal(parsed.strategy, "p2c")
    assert.equal(
      parsed.presets["rr-123"].strategy,
      "round-robin",
      "a nested key of the same name was overwritten",
    )
  })

  it("handles the last member, which has no trailing comma", () => {
    const out = setJsoncValue(file, "configReloadInterval", '"10s"')!
    assert.equal(JSON.parse(strip(out)).configReloadInterval, "10s")
  })

  it("writes booleans", () => {
    assert.equal(
      JSON.parse(strip(setJsoncValue(file, "autoSwitch", "false")!)).autoSwitch,
      false,
    )
  })

  it("adds a key that is not there yet", () => {
    const out = setJsoncValue(file, "retryPrefillError", "true")!
    const parsed = JSON.parse(strip(out))
    assert.equal(parsed.retryPrefillError, true)
    assert.equal(parsed.strategy, "sticky", "existing keys disturbed")
  })

  it("leaves the file parseable after a sequence of edits", () => {
    let out = file
    for (const [k, v] of [
      ["strategy", '"weighted"'],
      ["autoSwitch", "false"],
      ["retryPrefillError", "true"],
      ["configReloadInterval", '"7s"'],
    ] as const) {
      out = setJsoncValue(out, k, v)!
      assert.ok(out, `${k} returned null`)
    }
    const parsed = JSON.parse(strip(out))
    assert.equal(parsed.strategy, "weighted")
    assert.equal(parsed.autoSwitch, false)
    assert.equal(parsed.retryPrefillError, true)
    assert.equal(parsed.configReloadInterval, "7s")
  })

  it("refuses rather than guessing when there is no object", () => {
    assert.equal(
      setJsoncValue("// just a comment\n", "strategy", '"p2c"'),
      null,
    )
  })

  it("ignores a key that appears only in a comment", () => {
    const commented = `{
  // "strategy": "sticky",
  "autoSwitch": true
}
`
    // Nothing to replace, so it is added -- not written into the comment.
    const out = setJsoncValue(commented, "strategy", '"p2c"')!
    assert.ok(out.includes('// "strategy": "sticky",'), "comment was edited")
    assert.equal(JSON.parse(strip(out)).strategy, "p2c")
  })
})

describe("display", () => {
  it("renders a duration in the unit it was written in, not milliseconds", () => {
    assert.equal(display(43_200_000), "12h")
    assert.equal(display(300_000), "5m")
    assert.equal(display(3_000), "3s")
  })

  it("renders booleans as on/off rather than true/false", () => {
    assert.equal(display(true), "on")
    assert.equal(display(false), "off")
  })

  it("distinguishes unset from empty", () => {
    assert.equal(display(""), "(unset)")
    assert.equal(display(undefined), "(unset)")
  })

  it("leaves a ratio alone", () => {
    assert.equal(display(0.95), "0.95")
  })
})

describe("configRows", () => {
  it("shows one row per editable key, named and valued", () => {
    const rows = configRows({ ...DEFAULT_CONFIG })
    assert.equal(rows.length, EDITABLE.length)
    const strategy = rows.find((r) => r.value === "strategy")!
    assert.match(strategy.title, /^Strategy: /, "row is not labelled")
    assert.match(
      strategy.title,
      new RegExp(DEFAULT_CONFIG.strategy),
      "value missing",
    )
  })

  it("keeps the config key visible so the file stays searchable", () => {
    // A label alone leaves a reader unable to find the setting in the file.
    for (const row of configRows({ ...DEFAULT_CONFIG })) {
      assert.match(row.description, new RegExp(`\\(${row.value}\\)$`))
    }
  })

  it("groups every row under a section", () => {
    const rows = configRows({ ...DEFAULT_CONFIG })
    for (const row of rows)
      assert.ok(row.category.length > 0, `${row.value} has no section`)
    const sections = [...new Set(rows.map((r) => r.category))]
    assert.deepEqual(sections, ["Balancing", "Quota", "Tokens", "Diagnostics"])
  })

  it("orders rows so a section is contiguous, not interleaved", () => {
    // DialogSelect groups by category, but a reader scanning the raw list
    // should not see a section reappear further down.
    const seen: string[] = []
    for (const row of configRows({ ...DEFAULT_CONFIG })) {
      if (seen[seen.length - 1] !== row.category) seen.push(row.category)
    }
    assert.deepEqual(seen, [...new Set(seen)], "a section is split in two")
  })

  it("gives every key a distinct human label", () => {
    const labels = EDITABLE.map((e) => e.label)
    assert.equal(new Set(labels).size, labels.length, "duplicate label")
    for (const e of EDITABLE) {
      assert.notEqual(e.label, e.key, `${e.key} has no real label`)
    }
  })

  it("never renders a raw millisecond count at the user", () => {
    for (const row of configRows({ ...DEFAULT_CONFIG })) {
      assert.ok(
        !/\b\d{6,}\b/.test(row.description),
        `raw ms in: ${row.description}`,
      )
    }
  })
})

describe("optionsFor", () => {
  it("marks the current choice and only that one", () => {
    const e = EDITABLE.find((x) => x.key === "strategy")!
    const opts = optionsFor(e, "round-robin")
    assert.deepEqual(
      opts.filter((o) => o.description === "current").map((o) => o.value),
      ["round-robin"],
    )
  })

  it("offers on and off for a boolean, marking the live one", () => {
    const e = EDITABLE.find((x) => x.key === "autoSwitch")!
    const opts = optionsFor(e, true)
    assert.deepEqual(
      opts.map((o) => o.title),
      ["on", "off"],
    )
    assert.equal(opts.find((o) => o.value === "true")!.description, "current")
  })
})

describe("validateValue", () => {
  const ratio = EDITABLE.find((e) => e.key === "switchAt")!
  const duration = EDITABLE.find((e) => e.key === "ejectFor")!

  it("accepts a ratio and writes it as a number", () => {
    const out = validateValue(ratio, "0.85")
    assert.equal(out.ok, true)
    assert.equal(out.ok && out.literal, "0.85")
  })

  it("accepts a duration and keeps it quoted", () => {
    const out = validateValue(duration, "15m")
    assert.equal(out.ok, true)
    assert.equal(out.ok && out.literal, '"15m"')
  })

  it("refuses what the config layer would silently drop", () => {
    // Each of these reaches sanitize() and is discarded, which is exactly the
    // "dialog said OK and nothing changed" failure this prevents.
    for (const bad of ["0,95", "5 minutes", "yes", "abc", ""]) {
      const out = validateValue(ratio, bad)
      assert.equal(out.ok, false, `${JSON.stringify(bad)} was accepted`)
    }
  })

  it("explains itself with the key's own example", () => {
    const out = validateValue(duration, "nonsense")
    assert.equal(out.ok, false)
    assert.match(out.ok === false ? out.reason : "", /5m/)
  })

  it("says empty is empty rather than blaming the format", () => {
    const out = validateValue(duration, "   ")
    assert.equal(out.ok, false)
    assert.match(out.ok === false ? out.reason : "", /empty/)
  })
})

describe("optionsFor preset", () => {
  const preset = EDITABLE.find((e) => e.key === "preset")!

  it("lists the presets that exist, plus a way to clear", () => {
    const opts = optionsFor(preset, "", {
      "rr-12": {},
      "rr-123": { label: "LB 3" },
    })
    assert.deepEqual(
      opts.map((o) => o.value),
      ["__none__", "rr-12", "rr-123"],
    )
    assert.match(opts[2]!.title, /LB 3/)
  })

  it("marks an unset preset as (none), not as a missing preset", () => {
    const opts = optionsFor(preset, "", {})
    assert.equal(
      opts.find((o) => o.value === "__none__")!.description,
      "current",
    )
  })

  it("clears to an empty string, which is what the config reads as unset", () => {
    assert.equal(toLiteral("preset", "__none__"), '""')
  })
})

describe("validateValue is stricter than the config parsers", () => {
  const ratio = EDITABLE.find((e) => e.key === "switchAt")!
  const duration = EDITABLE.find((e) => e.key === "ejectFor")!

  it("rejects the inputs sanitize() silently turns into a default", () => {
    // Each of these survives sanitize(): "abc" becomes the default 0.95 and
    // "nonsense" becomes five minutes. A dialog that trusted sanitize would
    // report success and write a value the user never chose.
    for (const bad of ["abc", "yes", "0,95", "", "  "]) {
      assert.equal(validateValue(ratio, bad).ok, false, `ratio accepted ${bad}`)
    }
    for (const bad of ["nonsense", "5 minutes", "later", "0"]) {
      assert.equal(
        validateValue(duration, bad).ok,
        false,
        `duration accepted ${bad}`,
      )
    }
  })

  it("rejects the number that parseRatio reads as a percentage", () => {
    // parseRatio("5 minutes") is 0.05: it sees the 5 and treats it as percent.
    // Shape is checked before the parser is consulted, so this cannot happen.
    assert.equal(validateValue(ratio, "5 minutes").ok, false)
  })

  it("rejects a ratio outside the range it is allowed to be", () => {
    assert.equal(validateValue(ratio, "1.5").ok, false)
    assert.equal(validateValue(ratio, "0").ok, false)
    assert.equal(
      validateValue(ratio, "1").ok,
      true,
      "1.0 is a legitimate ratio",
    )
  })

  it("accepts the forms actually meant to work", () => {
    for (const good of ["0.5", ".75", "0.95", "80%", "1"]) {
      assert.equal(
        validateValue(ratio, good).ok,
        true,
        `ratio rejected ${good}`,
      )
    }
    for (const good of ["500ms", "30s", "5m", "12h", "1d"]) {
      assert.equal(
        validateValue(duration, good).ok,
        true,
        `duration rejected ${good}`,
      )
    }
  })

  it("does not let a duration through the ratio field, or the reverse", () => {
    assert.equal(validateValue(ratio, "5m").ok, false)
    assert.equal(validateValue(duration, "0.95").ok, false)
  })
})
