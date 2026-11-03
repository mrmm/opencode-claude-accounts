# Architecture

How the plugin is put together: the engines it is made of, the state they
share, and what happens to one request on its way to Anthropic and back.

Design decisions and their trade-offs are in [adr/](adr/README.md). Where each
fact is rendered in the TUI is in [src/tui/SURFACES.md](../src/tui/SURFACES.md).

## Two processes, one set of files

OpenCode runs the plugin twice: once in the server, which sends every model
request, and once in the TUI, which draws the sidebar, dialogs and commands.
They never call each other. They share state through files in
`~/.local/share/opencode/claude-auth/` and the config file, and each re-reads a file only
when it changed.

```mermaid
flowchart LR
  subgraph server["OpenCode server process"]
    entry["src/index.ts<br/>auth loader + fetch"]
    bal["balance/*<br/>selection, quota, usage"]
    ui["ui/*<br/>tools, toasts, label"]
  end
  subgraph tui["OpenCode TUI process"]
    tuix["tui/claude-auth-tui.tsx<br/>sidebar, dialogs, commands"]
    views["src/tui/*<br/>pure view builders"]
  end
  kc[("macOS Keychain<br/>Claude Code logins")]
  cfg[("claude-auth.jsonc<br/>config")]
  state[("state files<br/>quota, usage, samples,<br/>identities, selection")]
  api(["api.anthropic.com"])

  kc --> entry
  cfg --> entry
  cfg <--> tuix
  entry --> bal --> state
  entry <--> api
  state --> views --> tuix
  tuix -- "selection, config edits" --> state
  ui --> entry
```

| File (under `~/.local/share/opencode/`)                              | Written by | Read by  | Holds                                                            |
| -------------------------------------------------------------------- | ---------- | -------- | ---------------------------------------------------------------- |
| `claude-auth/quota.json`                                             | server     | both     | latest 5h / weekly utilisation and reset per account id          |
| `claude-auth/usage.jsonl`                                            | server     | both     | one row per request: account, session, tokens, cache use         |
| `claude-auth/samples.jsonl`                                          | server     | TUI      | a week of utilisation samples, for the pace forecast             |
| `claude-auth/identities.json`                                        | both       | both     | account and org per Keychain entry (owner-only)                  |
| `claude-auth/selection.txt`                                          | both       | both     | the current selection: an account, a preset, or auto             |
| `claude-auth/reserve-allows.json`, `claude-auth/credit-denials.json` | both       | server   | per-session opt-ins to reserved quota and paid credits           |
| `claude-auth/tui-folds.json`                                         | TUI        | TUI      | which sidebar sections are collapsed                             |
| `claude-auth/requests.jsonl`                                         | server     | operator | request captures, only when `captureRequests` is on (owner-only) |

Read-modify-write of shared files holds a short lock
([ADR 0004](adr/0004-cross-process-file-locks.md)); frequent readers parse a file
only when its size or mtime changed (`balance/file-memo.ts`).

## Engines

Each engine decides in pure functions and acts in a thin shell, so the policy
is testable without a Keychain, a network or a clock.

| Engine               | Decides                                                                  | Main files                                                                                                  | State                                         |
| -------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Credentials          | which Keychain logins exist, their tokens, refresh before expiry         | `credentials.ts`, `keychain.ts`, `refresh-lock.ts`                                                          | Keychain                                      |
| Identity             | the stable account/org pair behind each login                            | `balance/identity.ts`, `balance/accounts-id.ts`, `balance/account-key.ts`, `balance/migrate.ts`             | identities, config `accountIds`               |
| Selection (balancer) | which account serves the next request                                    | `balance/balancer.ts` (pure), `balance/rotate.ts` (applies), `balance/caps.ts`                              | selection file, config presets/groups/pools   |
| Sessions             | which account a given session is bound to; per-session opt-ins           | `balance/sessions.ts`                                                                                       | reserve/denial files                          |
| Quota                | each account's utilisation, from response headers                        | `balance/quota.ts`                                                                                          | quota cache                                   |
| Usage telemetry      | requests and tokens per account and session                              | `balance/usage.ts`, `balance/sse-usage.ts`, `balance/samples.ts`, `balance/cache-stats.ts`                  | usage log, samples                            |
| Request shaping      | turning OpenCode's request into one Anthropic accepts from Claude Code   | `request-body.ts`, `transforms.ts`, `signing.ts`, `betas.ts`, `model-config.ts`, `prefill.ts`               | none                                          |
| Cache and context    | cache TTL on existing markers; server-side context editing               | `balance/cache-ttl.ts`, `balance/context-edit.ts`                                                           | none                                          |
| Recovery             | what a refused request turns into: retry, rotate, or a paced "all spent" | `index.ts` (`fetchWithRetry`, `withSpentRetry`), `balance/rotate.ts` (`selectionRecovery`, `spentRetryNow`) | none                                          |
| Surfaces             | what the operator sees and can change                                    | `ui/*` (server), `src/tui/*` + `tui/*.tsx` (TUI), `config-edit.ts`                                          | config file                                   |
| Diagnostics          | logs, request captures, the debug block, the request trace               | `logger.ts`, `introspect.ts`, `tui/debug.ts`, `tui/requests.ts`                                             | log file, captures, `steps` on each usage row |

## One request

What `fetch` in `src/index.ts` does with a call to `/v1/messages`. Other
endpoints take the same path but get no context editing and no response
stream rewrite.

```mermaid
flowchart TD
  A["OpenCode calls fetch<br/>with x-opencode-session"] --> B{"bindBy = session?"}
  B -- yes --> C["Sessions: token of the account<br/>bound to this session"]
  B -- no --> D["Credentials: token of the<br/>active account"]
  C --> E
  D --> E["Parse the body once<br/>(model id)"]
  E --> F["Headers: OAuth bearer, Claude Code<br/>identity, betas minus excluded ones;<br/>drop x-api-key, content-length"]
  F --> G["prepareBody on the parsed object:<br/>1. Claude Code shape (billing header,<br/>identity block, system moved to user, tool names)<br/>2. cache TTL on existing markers<br/>3. context_management (Messages only)"]
  G --> H{"captureRequests on?"}
  H -- yes --> H1["describe the same object<br/>(no second parse)"] --> I
  H -- no --> I["send: fetchWithRetry<br/>(short 429/529 waits, up to 30s)"]
  I --> R{"status"}
  R -- "2xx" --> Q
  R -- "401" --> R1["refresh token, retry once"] --> R
  R -- "400 prefill" --> R2["drop trailing assistant turn,<br/>retry once"] --> R
  R -- "400 context editing" --> R3["switch editing off for the process,<br/>retry without it"] --> R
  R -- "400/429 long context" --> R4["exclude one beta, retry"] --> R
  R -- "429 quota" --> R5{"another account usable?"}
  R5 -- yes --> R6["rotate, retry once<br/>on the next account"] --> R
  R5 -- no --> R7["rewrite the 429: next account back<br/>+ paced retry-after"] --> Q
  Q["Quota: read rate-limit headers,<br/>write the quota cache"] --> S["Selection: rotate if the reading<br/>crossed a ceiling"]
  S --> T["Response: rewrite tool names in the<br/>SSE stream, tee token usage"]
  T --> U["Usage: one row per request,<br/>samples for the forecast"]
  U --> V(["back to OpenCode"])
```

Every branch taken is recorded, in order, as `steps` on the request's usage
row (`bound`/`active`, `ttl-1h`, `ctx-edit`, `auth-401`, `prefill-trim`,
`ctx-off`, `beta-off`, `rotate`, `spent`, `status`). `/cc-requests` lists recent
requests and shows each one's path through this diagram.

Each recovery branch runs at most once per request. The order matters: a
request refused for prefill and then for context editing is retried with both
fixes ([ADR 0005](adr/0005-request-body-rewrites.md)).

## Choosing an account

The balancer is a pure function of the accounts, the quota cache, the config
and the time. `rotate.ts` calls it and applies the answer.

```mermaid
flowchart LR
  sel["selection file<br/>account / preset / auto"] --> cfg["resolveActiveConfig:<br/>preset overrides config"]
  cfg --> pools["resolvePools:<br/>tiers of accounts,<br/>group ids expanded"]
  pools --> assess["assess each account:<br/>credentials, ejection,<br/>quota vs ceiling, credits"]
  assess --> strat["strategy:<br/>sticky, priority, least-loaded,<br/>least-used, round-robin, weighted, ..."]
  strat --> dec{"different from<br/>the active account?"}
  dec -- yes --> move["setActiveAccountSource,<br/>record rotation, notice"]
  dec -- no --> stay["keep serving"]
```

Rotation is checked on a timer, after every quota reading and on a 429. A pin
blocks it when `pinBlocksRotation` is on.

## When every account is spent

```mermaid
sequenceDiagram
  participant OC as OpenCode
  participant P as Plugin fetch
  participant B as Balancer
  participant A as Anthropic

  OC->>P: POST /v1/messages
  P->>A: request on account X
  A-->>P: 429, retry-after 896
  P->>B: noteRejection(X)
  B-->>P: no usable account
  P->>B: selectionRecovery()
  B-->>P: next back: Y at 20:49
  P-->>OC: 429, message "Next back: Y at 20:49",<br/>retry-after = wait / 9 (60s..15min)
  Note over OC: up to 10 retries,<br/>the last lands at the reset
  OC->>P: retry
  P->>A: request on account Y
  A-->>P: 200
  P-->>OC: stream
```

The sidebar shows the same answer ("all spent · next back Y at 20:49") from the
same function ([ADR 0003](adr/0003-spent-pool-retry-pacing.md)).

## The TUI

The TUI never talks to the server. It polls the state files, builds every view
in a pure function under `src/tui/`, and writes changes to the selection file
or the config file, which the server re-reads on its next request.

```mermaid
flowchart LR
  files[("quota, usage, samples,<br/>identities, selection, config")] -->|poll| snap["snapshot"]
  snap --> chip["chip.ts<br/>prompt chip, sidebar rows, picker"]
  snap --> groups["groups.ts<br/>group sections"]
  snap --> forecast["forecast.ts<br/>pace forecast"]
  snap --> spent["spent.ts<br/>all-spent line"]
  snap --> caps["caps-ui.ts<br/>caps, cache, advice"]
  snap --> reqs["requests.ts<br/>request list and trace"]
  chip & groups & forecast & spent & caps & reqs --> tsx["claude-auth-tui.tsx"]
  tsx -->|"pick account / preset"| sel[("selection file")]
  tsx -->|"settings, presets, groups"| cfgw[("claude-auth.jsonc")]
```
