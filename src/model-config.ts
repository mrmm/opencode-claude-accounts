import { execFileSync } from "node:child_process"

export interface ModelOverride {
  exclude?: string[]
  add?: string[]
  disableEffort?: boolean
}

export interface ModelConfig {
  ccVersion: string
  baseBetas: string[]
  longContextBetas: string[]
  modelOverrides: Record<string, ModelOverride>
}

/**
 * The Claude Code version this reports itself as.
 *
 * Anthropic gates models on it: a model released after the claimed version is
 * refused outright ("version 2.1.280 or newer is required"). A hardcoded
 * string is therefore a expiry date -- it worked until a model shipped behind
 * a newer gate, and then silently blocked that model while everything else
 * kept working, which is the hardest kind of stale to notice.
 *
 * So it is READ from the installed CLI, which is the version an unmodified
 * Claude Code would send. The constant below is only the fallback for a
 * machine where `claude` is not on PATH, and ANTHROPIC_CLI_VERSION overrides
 * both for anyone who needs to pin it.
 */
function detectCliVersion(fallback: string): string {
  try {
    // Synchronous and cached in the module, so this is one subprocess for the
    // life of the process rather than one per request.
    const out = execFileSync("claude", ["--version"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    })
    // "2.1.282 (Claude Code)" -- take the version, ignore the rest.
    const m = /(\d+\.\d+\.\d+)/.exec(out)
    return m?.[1] ?? fallback
  } catch {
    return fallback
  }
}

/** Where the CLI is absent. Raise it when it starts blocking a model. */
export const FALLBACK_CC_VERSION = "2.1.282"

export const config: ModelConfig = {
  ccVersion: detectCliVersion(FALLBACK_CC_VERSION),
  baseBetas: [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "prompt-caching-scope-2026-01-05",
    "context-management-2025-06-27",
    "advisor-tool-2026-03-01",
    "thinking-token-count-2026-05-13",
    "extended-cache-ttl-2025-04-11",
  ],
  longContextBetas: [
    "context-1m-2025-08-07",
    "interleaved-thinking-2025-05-14",
  ],
  // NOTE: getModelOverride is first-match-wins. The "sonnet" key must stay
  // ahead of "4-6"/"4-7": it shields claude-sonnet-4-6 from the "4-6"
  // effort add-override, and its exclude strips effort if a user supplies
  // it via ANTHROPIC_BETA_FLAGS. Do not remove it as inert — the split is
  // pinned by the "effort beta" test in betas.test.ts.
  modelOverrides: {
    sonnet: {
      exclude: ["effort-2025-11-24"],
    },
    haiku: {
      exclude: ["effort-2025-11-24"],
      disableEffort: true,
    },
    "4-6": {
      add: ["effort-2025-11-24"],
    },
    "4-7": {
      add: ["effort-2025-11-24"],
    },
  },
}

/**
 * Find the override entry matching a model ID.
 * Keys are matched via includes() against the lowercased model ID.
 *
 * First-match-wins: if multiple keys match, only the first (by insertion
 * order) is returned. List more specific keys before broader ones
 * (e.g. "opus-4-6" before "opus") so they take priority.
 */
export function getModelOverride(modelId: string): ModelOverride | null {
  const lower = modelId.toLowerCase()
  for (const [pattern, override] of Object.entries(config.modelOverrides)) {
    if (lower.includes(pattern)) return override
  }
  return null
}
