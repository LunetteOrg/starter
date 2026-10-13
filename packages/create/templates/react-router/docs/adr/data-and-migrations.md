---
status: accepted
date: 2026-07-02
tags: [database, postgres, drizzle, migrations]
---

# ADR-0005: Data & migrations

How schema changes ship safely under rolling deploys, and how those rules are mechanically enforced.

## Expand-migrate-contract

### Context

Deploys are rolling/blue-green: old and new code briefly run against the same database. A destructive schema change in a single step breaks whichever version doesn't expect it. Rollbacks must never require a DB revert.

### Decision

Destructive schema changes ship across three releases:

1. **Expand** — add the new structure, keep the old (backward-compatible deploy).
2. **Migrate** — move data; the app writes to both old and new.
3. **Contract** — remove the old structure once nothing reads it.

CI order is `migrate → test → deploy`: migrations run against the (ephemeral CI / production) database before e2e tests, and the deploy only happens if tests pass. Because every migration is backward compatible by design, a failed pipeline means "don't deploy" — the already-migrated DB remains valid for the currently running code.

### Consequences

- \+ Zero-downtime deploys; rollback is simply not deploying.
- − One logical change becomes two or three PRs, and the intermediate dual-write code must be written and later removed.
- − Requires discipline in review: any `DROP`/`RENAME` in a migration is a red flag unless it's a contract step.

## Migration-safety guard

### Context

[Expand-migrate-contract](#expand-migrate-contract) leaves two rules to human review: "any
`DROP`/`RENAME` in a migration is a red flag unless it's a contract step", and
rollback is never a DB revert (no down-migrations). Review red-flags get missed.
Per the principle in [self-arming enforcement](./0002-architecture-and-boundaries.md#self-arming-enforcement) (enforcement lands now, inert until needed), this
can be mechanized today without any application schema: there are no migrations
yet, so a guard scans nothing and arms itself when the first one lands.

A hard ban on `DROP`/`RENAME` would be wrong — the contract phase legitimately
drops the old structure. The check must distinguish an intentional contract step
from an accidental destructive change.

### Decision

Add a self-arming check (`packages/test-utils/src/migration-safety.ts`, run by
`migration-safety.spec.ts`) that scans `**/drizzle/**/*.sql` across the repo:

- **Down-migrations are forbidden.** A `*.down.sql` file or a `down/` segment
  fails — rollback is "don't deploy" ([expand-migrate-contract](#expand-migrate-contract)).
- **Risky statements must be acknowledged, per statement.** A statement
  containing `DROP …`, `ALTER TABLE … RENAME …`, `ALTER COLUMN … SET NOT NULL`,
  `ALTER COLUMN … TYPE`, `TRUNCATE`, or `DELETE FROM` must carry an annotation
  in its own statement: `-- contract: <reason>` for a contract-phase removal, or
  `-- destructive: <reason>` for any other reviewed risky op. Otherwise it
  fails, pointing the author to annotate or split into expand/migrate/contract.

Detection masks comments and string literals (so a keyword inside them is not a
false positive) and evaluates each `;`-separated statement on its own, so one
annotation can't whitewash a sibling statement. The rule logic is a pure
function (`checkMigration(name, content)`) so it is unit-tested directly; the
repo scan applies it centrally (no per-app setup).

### Consequences

- \+ The [expand-migrate-contract](#expand-migrate-contract) red-flags fail CI instead of relying on a reviewer.
- \+ Inert until the first migration; central, no per-app copy.
- \+ Contract drops remain possible — they just have to be declared.
- − Introduces a `-- contract:` / `-- destructive:` annotation convention
  authors must learn.
- − Regex-based: comment/string masking and per-statement splitting cover the
  common cases, but it is a guard rail, not a SQL parser, and unusual formatting
  can still fool it. Tighten it if a real migration slips through.
