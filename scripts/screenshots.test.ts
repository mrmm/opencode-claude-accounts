import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  changedFeatures,
  FEATURES,
  releaseNotes,
  renderSvg,
  SCENES,
} from "./screenshots.ts"

describe("screenshots", () => {
  it("renders every feature, and only demo identities", () => {
    for (const f of FEATURES) {
      const svg = renderSvg(SCENES[f.id]!())
      assert.match(svg, /^<svg /, f.id)
      assert.ok(svg.split("<text").length > 4, `${f.id} has content`)
      for (const email of svg.match(/[\w.+-]+@[\w.-]+/g) ?? [])
        assert.match(email, /@example\.com$/, `${f.id}: ${email}`)
    }
  })

  it("escapes markup in text", () => {
    assert.match(renderSvg([[{ t: "a<b>&" }]]), /a&lt;b&gt;&amp;/)
  })

  it("features a release by the files it changed", () => {
    const ids = (p: string[]) => changedFeatures(p).map((f) => f.id)
    assert.deepEqual(ids(["src/tui/forecast.ts"]), ["forecast"])
    assert.deepEqual(ids(["README.md", ""]), [])
    assert.ok(ids(["src/tui/chip.ts"]).includes("sidebar"))
  })

  it("links the release's own PNGs, and says nothing when nothing changed", () => {
    const notes = releaseNotes(
      changedFeatures(["src/tui/forecast.ts"]),
      "o/r",
      "v1.2.3",
    )
    assert.match(notes, /^## Screenshots/)
    assert.match(
      notes,
      /\(https:\/\/github\.com\/o\/r\/releases\/download\/v1\.2\.3\/forecast\.png\)/,
    )
    assert.equal(releaseNotes([], "o/r", "v1"), "")
  })
})
