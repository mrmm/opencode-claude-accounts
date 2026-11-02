# 0001. Accounts are keyed by a stable id, read through one accessor

Status: Accepted

## Context

Accounts used to be identified by their Keychain entry name. That name changes
when an account is logged in again, so quota, usage and cache data were lost or
orphaned. Moving to stable ids (`acme-1`) left old entries under the Keychain
name next to new ones under the id.

Readers that indexed the quota cache by Keychain name directly then read the
old entry. A window that had already reset read as 0% used, and the sidebar
showed an account as healthy while the server was refusing it.

## Decision

- Quota, usage and samples are keyed by account id.
- Every reader goes through one accessor (`quotaEntry`, `quotaForAccount`),
  which tries the id first and falls back to the old key.
- Writing a reading under the id deletes the superseded entry.
- Usage counts sum both keys (`servedBy`, `usageOf`), so rows logged before the
  move still count.

## Consequences

- One place decides how an account's data is found; a new reader that indexes
  a cache directly is a bug.
- Old entries disappear as accounts are used, without a migration step.
