/**
 * Release screenshots, rendered from demo accounts.
 *
 *   node --experimental-strip-types scripts/screenshots.ts render <dir>
 *   git diff --name-only <prev> <tag> |
 *     node --experimental-strip-types scripts/screenshots.ts notes <repo> <tag>
 *
 * `render` writes one SVG per feature using the plugin's own render functions,
 * so a release shows what its code draws. `notes` reads changed paths on stdin
 * and prints a markdown section with the features those paths touch, linking
 * the PNGs the release workflow uploads next to the tarball.
 *
 * Demo data only: the repository is public, so no real account, email or
 * organisation ever reaches an image.
 */
// Reset clocks render in local time; pin it so every machine draws the same.
process.env.TZ = "UTC"

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { formatQuotaPrefix, type QuotaCache } from "../src/balance/index.ts"
import {
  accountDetail,
  accountHealth,
  buildPickerOptions,
  sidebarLines,
  type Health,
} from "../src/tui/chip.ts"
import { forecast, forecastSummaryRows } from "../src/tui/forecast.ts"
import { groupRows } from "../src/tui/groups.ts"
import type { Row } from "../src/tui/tokens.ts"

export type Feature = { id: string; title: string; files: string[] }

/** Which source files each screenshot shows; a change to any re-features it. */
export const FEATURES: Feature[] = [
  {
    id: "sidebar",
    title: "Sidebar: accounts as a tree, gauges and reset countdowns",
    files: [
      "tui/claude-auth-tui.tsx",
      "src/tui/chip.ts",
      "src/tui/groups.ts",
      "src/balance/quota.ts",
    ],
  },
  {
    id: "forecast",
    title: "Forecast: does the pool last until it refills?",
    files: ["src/tui/forecast.ts", "tui/claude-auth-tui.tsx"],
  },
  {
    id: "picker",
    title: "Account picker",
    files: ["src/tui/chip.ts", "tui/claude-auth-tui.tsx"],
  },
  {
    id: "status",
    title: "claude_accounts_status tool",
    files: [
      "src/ui/tools.ts",
      "src/ui/tools-format.ts",
      "src/tui/chip.ts",
      "src/balance/identity.ts",
    ],
  },
]

/** Catppuccin Mocha, the palette the screenshots are taken in. */
const C = {
  bg: "#1e1e2e",
  text: "#cdd6f4",
  muted: "#7f849c",
  ok: "#a6e3a1",
  warn: "#f9e2af",
  critical: "#f38ba8",
  info: "#89b4fa",
  accent: "#cba6f7",
}
type Colour = keyof typeof C
export type Seg = { t: string; c?: Colour; b?: boolean }
export type Line = Seg[]

const health: Record<Health, Colour> = {
  ok: "ok",
  warn: "warn",
  paid: "info",
  critical: "critical",
  unknown: "muted",
}
const label = (g: { title: string; count: string }) => `${g.title} ${g.count}`
const clock = (s: number) => new Date(s * 1000).toISOString().slice(11, 16)
const level = (l?: Row["level"]): Colour =>
  l === "critical" ? "critical" : l === "warn" ? "warn" : "text"

// --- demo data ---------------------------------------------------------------

export const NOW = 1_800_000_000
const H = 3600
const D = 86400
const win = (u: number, inS: number) => ({
  utilization: u,
  resetsAt: NOW + inS,
})
const ACCOUNTS = [
  { source: "s1", label: "Acme 1" },
  { source: "s2", label: "Acme 2" },
  { source: "s3", label: "Acme 3" },
  { source: "s4", label: "Acme 2 alt" },
  { source: "s5", label: "Acme 1 alt" },
]
const NAMES = new Map([
  ["s1", "Team 1"],
  ["s2", "Team 2"],
  ["s3", "Team 3"],
  ["s4", "Team 2"],
  ["s5", "Team 1"],
])
const GROUPS = { Main: ["s1", "s2", "s3"], Alt: ["s4", "s5"] }
const QUOTA = {
  s1: {
    fiveHour: win(0, 3 * H + 840),
    sevenDay: win(0.97, 4 * D + 16 * H),
    extra: {
      enabled: true,
      capReached: false,
      usedMinor: 11378,
      limitMinor: 20000,
      currency: "EUR",
    },
    observedAt: NOW,
  },
  s2: {
    fiveHour: win(0.57, 3 * H + 2040),
    sevenDay: win(0.06, 6 * D + 22 * H),
    observedAt: NOW,
  },
  s3: {
    fiveHour: win(0.95, H + 3240),
    sevenDay: win(0.81, 4 * D + 10 * H),
    limits: [
      {
        kind: "weekly_scoped",
        percent: 40,
        severity: "warning",
        active: true,
        model: "Opus",
        allowance: 50,
      },
    ],
    observedAt: NOW,
  },
  s4: { sevenDay: win(1, 12 * H + 240), observedAt: NOW },
  s5: {
    fiveHour: win(0.48, 2 * H + 1440),
    sevenDay: win(0.5, 5 * D + 6 * H),
    observedAt: NOW,
  },
} as unknown as QuotaCache
const IDS = Object.fromEntries(
  ACCOUNTS.map((a, i) => [
    a.source,
    {
      email: `dev${i + 1}@example.com`,
      plan: "claude_team",
      tier: "default_claude_max_5x",
    },
  ]),
)
const TH = { warnAt: 0.9, weeklyWarnAt: 0.85 }

// --- scenes ------------------------------------------------------------------

/**
 * The sidebar block as the TUI lays it out: title, mode, then each group with
 * its accounts hanging off it. shortcut: mirrors the tree layout in
 * claude-auth-tui.tsx by hand; lift it into chip.ts if the two ever drift.
 */
function sidebar(): Line[] {
  const view = sidebarLines({
    accounts: ACCOUNTS,
    names: NAMES,
    quota: QUOTA,
    selection: "preset:spread",
    activeSource: "s2",
    hiddenCount: 1,
    now: NOW,
    thresholds: TH,
  })
  const sections = groupRows({
    groups: Object.fromEntries(
      Object.entries(GROUPS).map(([k, v]) => [k, { accounts: v }]),
    ),
    accounts: ACCOUNTS,
    quota: QUOTA,
    resolve: (s) => s,
    thresholds: TH,
    now: NOW,
  })
  const col = Math.max(
    ...ACCOUNTS.map((a) => NAMES.get(a.source)!.length + 4),
    ...sections.map((g) => label(g).length + 2),
  )
  const lines: Line[] = [
    [
      { t: "\u25be ", c: "text" },
      { t: "Claude Auth", c: "text", b: true },
      { t: " v3.0.0", c: "muted" },
    ],
    [{ t: `  ${view.heading}`, c: "muted" }],
  ]
  for (const g of sections) {
    lines.push([
      { t: "\u25be ", c: "text" },
      { t: label(g).padEnd(col - 2), c: "text", b: true },
      { t: `  ${g.summary}`, c: health[g.health] },
    ])
    g.sources.forEach((s, k) => {
      const row = view.rows[ACCOUNTS.findIndex((a) => a.source === s)]!
      const last = k === g.sources.length - 1
      const cont = last ? "  " : "\u2502 "
      lines.push([
        { t: last ? "\u2514 " : "\u251c ", c: "muted" },
        { t: row.active ? "\u25cf " : "\u00b7 ", c: health[row.health] },
        {
          t: NAMES.get(s)!.padEnd(col - 4),
          c: row.active ? "text" : "muted",
        },
        { t: `  ${row.detail}`, c: health[row.health] },
      ])
      if (row.sub) lines.push([{ t: `${cont}  ${row.sub}`, c: "muted" }])
      if (row.more)
        lines.push([{ t: `${cont}  ${row.more}`, c: health[row.health] }])
    })
  }
  return lines
}

function forecastScene(): Line[] {
  // An hour of steady burn on the serving account.
  const samples = Array.from({ length: 13 }, (_, i) => ({
    account: "s2",
    at: (NOW - (60 - i * 5) * 60) * 1000,
    u5: 0.2 + i * 0.03,
    u7: 0.03 + i * 0.0025,
  }))
  const f = forecast(
    samples,
    QUOTA,
    ACCOUNTS.map((a) => a.source),
    NOW,
  )
  return [
    [
      { t: "\u25be ", c: "text" },
      { t: "Forecast", c: "text", b: true },
      { t: ` (now ${Math.round(f.nowPace * 100)}%/h)`, c: "muted" },
    ],
    ...forecastSummaryRows(f, clock, NAMES).map((r) => [
      { t: r.label.padEnd(13), c: "muted" as Colour },
      { t: r.value, c: level(r.level) },
    ]),
  ]
}

function picker(): Line[] {
  const options = buildPickerOptions({
    accounts: ACCOUNTS.slice(0, 3),
    names: NAMES,
    presets: {
      spread: { label: "Spread by headroom", strategy: "least-loaded" },
    },
    quota: QUOTA,
    selection: "preset:spread",
    now: NOW,
    identities: IDS,
  })
  const lines: Line[] = [[{ t: "Switch Claude account", c: "text", b: true }]]
  let category = ""
  for (const o of options) {
    if (o.category !== category) {
      category = o.category ?? ""
      lines.push([], [{ t: category, c: "accent", b: true }])
    }
    lines.push([{ t: `  ${o.title}`, c: "text" }])
    if (o.description) lines.push([{ t: `    ${o.description}`, c: "muted" }])
  }
  return lines
}

/** shortcut: the account block of the tool's output, rebuilt from the same helpers. */
function status(): Line[] {
  const lines: Line[] = [
    [{ t: "serving now: s2 (Team 2) \u2014 bound to this session", c: "text" }],
    [
      {
        t: 'selection:   preset "Spread by headroom" (least-loaded)',
        c: "text",
      },
    ],
    [],
    [{ t: "accounts (* = serving this session):", c: "text" }],
  ]
  for (const a of ACCOUNTS) {
    const h = accountHealth(QUOTA, a.source, TH)
    const prefix = formatQuotaPrefix(QUOTA[a.source], NOW) || "[no reading]"
    lines.push([
      {
        t: `  ${a.source === "s2" ? "*" : " "} ${a.source.padEnd(4)} ${NAMES.get(a.source)!.padEnd(8)} ${prefix.padEnd(16)} `,
        c: "text",
      },
      { t: h === "critical" ? "unusable" : "usable", c: health[h] },
    ])
    const detail = accountDetail(QUOTA, a.source, IDS[a.source])
    if (detail) lines.push([{ t: `      ${detail}`, c: "muted" }])
  }
  return lines
}

export const SCENES: Record<string, () => Line[]> = {
  sidebar,
  forecast: forecastScene,
  picker,
  status,
}

// --- output ------------------------------------------------------------------

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const cells = (s: string) => [...s].length

/** Lines of coloured segments as an SVG terminal pane, one cell per column. */
export function renderSvg(lines: Line[]): string {
  const size = 15
  const cw = size * 0.6
  const lh = size * 1.45
  const pad = 16
  const cols = Math.max(
    20,
    ...lines.map((l) => cells(l.map((s) => s.t).join(""))),
  )
  const w = Math.ceil(cols * cw + pad * 2)
  const h = Math.ceil(lines.length * lh + pad * 2)
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<rect width="${w}" height="${h}" rx="8" fill="${C.bg}"/>`,
    `<g font-family="DejaVu Sans Mono, Menlo, Consolas, monospace" font-size="${size}" xml:space="preserve">`,
  ]
  lines.forEach((line, i) => {
    let col = 0
    const y = (pad + (i + 0.8) * lh).toFixed(1)
    for (const s of line) {
      if (s.t.trim())
        out.push(
          `<text x="${(pad + col * cw).toFixed(1)}" y="${y}" fill="${C[s.c ?? "text"]}"${s.b ? ' font-weight="bold"' : ""}>${esc(s.t)}</text>`,
        )
      col += cells(s.t)
    }
  })
  out.push("</g></svg>")
  return out.join("\n")
}

/** Features whose files appear in a list of changed paths. */
export function changedFeatures(paths: string[]): Feature[] {
  const set = new Set(paths.map((p) => p.trim()).filter(Boolean))
  return FEATURES.filter((f) => f.files.some((x) => set.has(x)))
}

/** The release-notes section for the features a release changed, or "". */
export function releaseNotes(
  features: Feature[],
  repo: string,
  tag: string,
): string {
  if (features.length === 0) return ""
  const base = `https://github.com/${repo}/releases/download/${tag}`
  return [
    "## Screenshots",
    "",
    ...features.flatMap((f) => [
      `**${f.title}**`,
      "",
      `![${f.title}](${base}/${f.id}.png)`,
      "",
    ]),
  ].join("\n")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, a, b] = process.argv.slice(2)
  if (cmd === "render" && a) {
    mkdirSync(a, { recursive: true })
    for (const [id, scene] of Object.entries(SCENES))
      writeFileSync(join(a, `${id}.svg`), renderSvg(scene()))
  } else if (cmd === "notes" && a && b) {
    const paths = readFileSync(0, "utf8").split("\n")
    process.stdout.write(releaseNotes(changedFeatures(paths), a, b))
  } else {
    console.error("usage: screenshots.ts render <dir> | notes <repo> <tag>")
    process.exit(2)
  }
}
