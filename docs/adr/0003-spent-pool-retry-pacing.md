# 0003. A spent pool paces retries to reach the next reset

Status: Accepted

## Context

When every account refuses a request, the server's `retry-after` can be hours
away, and its message does not say which account comes back first. OpenCode
retries a 429 a fixed number of times (10 as of 2.2.x) and caps each wait at
15 minutes.

A short fixed `retry-after` (60s) picks up a freed or added account quickly,
but runs out of retries after about ten minutes, long before any reset.

## Decision

- The final 429 keeps its Anthropic error shape. Its message names the next
  account back and the clock time. The server's own message is kept as
  `error.upstream_message`.
- `retry-after` is the wait until that account is back, spread over all but
  one of OpenCode's retries, kept between 60 seconds and 15 minutes. The
  retries then reach the reset and the request resumes by itself.
- The retry count can be changed with `OPENCODE_CLAUDE_AUTH_HOST_RETRIES` if
  OpenCode's own count changes.
- The sidebar shows the same answer ("all spent · next back …") while nothing
  in the selection can serve; both use one function (`selectionRecovery`).

## Consequences

- An account freed or added during a long wait is noticed at the next retry,
  up to 15 minutes later, instead of within a minute.
- The pacing depends on OpenCode's retry count, which is not part of a public
  contract.
