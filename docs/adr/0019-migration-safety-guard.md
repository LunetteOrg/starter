# ADR-0019: Mechanized migration-safety guard

- Status: accepted
- Date: 2026-06-30

## Context

ADR-0007 (expand-migrate-contract) leaves two rules to human review: "any
`DROP`/`RENAME` in a migration is a red flag unless it's a contract step", and
rollback is never a DB revert (no down-migrations). Review red-flags get missed.
Per the principle in ADR-0016 (enforcement lands now, inert until needed), this
can be mechanized today without any application schema: there are no migrations
yet, so a guard scans nothing and arms itself when the first one lands.

A hard ban on `DROP`/`RENAME` would be wrong — the contract phase legitimately
drops the old structure. The check must distinguish an intentional contract step
from an accidental destructive change.

## Decision

Add a self-arming check (`packages/test-utils/src/migration-safety.ts`, run by
`migration-safety.spec.ts`) that scans `**/drizzle/**/*.sql` across the repo:

- **Down-migrations are forbidden.** A `*.down.sql` file or a `down/` segment
  fails — rollback is "don't deploy" (ADR-0007).
- **Destructive statements must be an explicit contract step.** A migration
  containing `DROP …` or `ALTER TABLE … RENAME …` must carry a `-- contract:`
  annotation; otherwise it fails, pointing the author to either annotate it or
  split it into expand/migrate/contract.

The rule logic is a pure function (`checkMigration(name, content)`) so it is
unit-tested directly; the repo scan applies it centrally (no per-app setup).

## Consequences

- \+ The ADR-0007 red-flags fail CI instead of relying on a reviewer.
- \+ Inert until the first migration; central, no per-app copy.
- \+ Contract drops remain possible — they just have to be declared.
- − Introduces a `-- contract:` annotation convention authors must learn.
- − Regex-based: it can be fooled by unusual SQL formatting. It is a guard rail,
  not a parser; tighten it if a real migration slips through.
