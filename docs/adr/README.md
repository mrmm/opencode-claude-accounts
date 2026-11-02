# Architecture decisions

One file per decision: the context, what was decided, and what it costs.
Superseded decisions stay, marked as such.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-stable-account-ids.md) | Accounts are keyed by a stable id, read through one accessor | Accepted |
| [0002](0002-account-groups.md) | Account groups have a stable id and an editable label | Accepted |
| [0003](0003-spent-pool-retry-pacing.md) | A spent pool paces retries to reach the next reset | Accepted |
| [0004](0004-cross-process-file-locks.md) | Shared state files are written under a short cross-process lock | Accepted |
| [0005](0005-request-body-rewrites.md) | The request body is parsed once, and rewrites are scoped to Messages | Accepted |
