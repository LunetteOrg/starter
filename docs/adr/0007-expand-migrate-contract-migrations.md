# ADR-0007: Expand-Migrate-Contract for schema migrations

- Status: accepted
- Date: 2026-03-17

## Context

Deploys are rolling/blue-green: old and new code briefly run against the same database. A destructive schema change in a single step breaks whichever version doesn't expect it. Rollbacks must never require a DB revert.

## Decision

Destructive schema changes ship across three releases:

1. **Expand** — add the new structure, keep the old (backward-compatible deploy).
2. **Migrate** — move data; the app writes to both old and new.
3. **Contract** — remove the old structure once nothing reads it.

CI order is `migrate → test → deploy`: migrations run against the (ephemeral CI / production) database before e2e tests, and the deploy only happens if tests pass. Because every migration is backward compatible by design, a failed pipeline means "don't deploy" — the already-migrated DB remains valid for the currently running code.

## Consequences

- \+ Zero-downtime deploys; rollback is simply not deploying.
- − One logical change becomes two or three PRs, and the intermediate dual-write code must be written and later removed.
- − Requires discipline in review: any `DROP`/`RENAME` in a migration is a red flag unless it's a contract step.
