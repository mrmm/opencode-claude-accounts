# 0004. Shared state files are written under a short cross-process lock

Status: Accepted

## Context

The plugin server and the TUI run in separate processes and both
read-modify-write the same files (account profiles, quota cache, config during
migration). Writing to a temp file and renaming it prevents a torn file but
not a lost update: the slower writer overwrites the other's change. With two
processes writing 40 entries each, 12 to 15 of 80 were lost per run.

## Decision

- Read-modify-write of those files holds `<file>.lock`, created exclusively.
- A lock left by a dead process, or older than 30 seconds, is taken over.
- After a short wait (500 ms; 2 s for migration) the write proceeds unlocked:
  a missed update costs less than a stalled request.

## Consequences

- Concurrent writers no longer lose entries (0 of 80 lost in the same test).
- Under heavy contention past the wait, an update can still be lost.
- Account profiles are now fetched in parallel at start-up, which relies on
  this lock.
