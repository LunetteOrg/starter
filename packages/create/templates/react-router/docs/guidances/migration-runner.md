# Migration runner

- Status: guidance

> **Analysis, not shipped.** The starter ships no database, no `drizzle-kit`, and
> no migration runner yet. This is the analysis to run **before** the first
> persistence package lands, to decide whether the migration *runner* is a real
> choice — and, if so, how to keep `drizzle` and `CREATE INDEX CONCURRENTLY`
> together. The deep comparison and the final pick are tracked in
> **[issue #14](https://github.com/LunetteOrg/starter/issues/14)**; the outcome
> belongs in a future *Migration runner* section of
> [ADR-0005](../adr/0005-data-and-migrations.md).

## The question

The template already prescribes a lot about migrations without shipping any:

- [ADR-0005](../adr/0005-data-and-migrations.md) decides **expand-migrate-contract**, a
  **self-arming safety guard** over `**/drizzle/**/*.sql` (no down-migrations;
  `DROP`/`RENAME`/`SET NOT NULL`/… must carry a `-- contract:` or
  `-- destructive:` annotation), and the CI order `migrate → test → deploy`.
- The **`postgres` skill** (`.claude/skills/postgres/`) teaches `CREATE INDEX
  CONCURRENTLY`, per-statement (separate) transactions, `lock_timeout` /
  `statement_timeout` with retry loops, and fork-based testing.

What is **not** decided anywhere: *how the SQL actually gets applied.* There is
no runner pinned because there is no db package. This document asks whether that
silence is a harmless gap-until-later or a contradiction that will bite the first
person who wires persistence.

## Why it is a real decision moment

Because the prescribed patterns and the obvious runner **contradict each other.**
The skill tells authors to use `CONCURRENTLY` and separate transactions; the
default `drizzle` runner does the opposite — and does so silently until it throws
in production.

## How drizzle applies migrations (verified)

`drizzle` splits the two halves of the job:

- **Authoring** — `drizzle-kit generate` diffs `schema.ts` and emits versioned
  SQL files under `drizzle/`, statements separated by `--> statement-breakpoint`.
- **Applying** — `drizzle-kit migrate` (CLI) / `migrate()` (`drizzle-orm`,
  programmatic) replays the pending files, tracked in `__drizzle_migrations`,
  forward-only.

The applying half is the crux. Read against `drizzle-orm` **0.45.2**
(`pg-core/dialect.js`, `PgDialect.migrate`), the runner wraps **all pending
migrations in a single transaction** — not one transaction per file:

```js
await session.transaction(async (tx) => {
  for await (const migration of migrations) {
    if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) {
      for (const stmt of migration.sql) {
        await tx.execute(sql.raw(stmt));            // every statement, same tx
      }
      await tx.execute(sql`insert into … __drizzle_migrations …`);
    }
  }
});
```

Consequences that matter here:

- **`CREATE INDEX CONCURRENTLY` fails.** Postgres forbids it inside a transaction
  block (`ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction
  block`). Same for `DROP INDEX CONCURRENTLY`, `ALTER TYPE … ADD VALUE` on older
  PG, and anything that demands its own transaction context.
- **`--> statement-breakpoint` does not help.** It splits statements *within* the
  transaction; it does not open/close one. There is no per-file "no transaction"
  escape in this version.
- So the `postgres` skill's own advice — the `CONCURRENTLY` recipe on
  `postgres-database-migration.md`, and its "separate transactions" strategy — is
  **not executable through the default runner.** The two pieces of template
  guidance point in opposite directions.

> **Verify at decision time.** This is long-standing `drizzle` behaviour, but pin
> the check to whatever version the db package selects — and re-check whether
> `drizzle-kit` has since added a per-migration transaction opt-out (long
> requested upstream). If it has, the custom-applier option gets much cheaper.

## The tension in one line

ADR-0005 and the `postgres` skill assume you *can* run `CONCURRENTLY` and
per-statement DDL. `drizzle`'s default runner forbids both. Something has to give
— and choosing what gives *is* the runner decision.

## The runner candidates

The candidates sort by **how far they pull authoring away from `drizzle`**
(`schema.ts` → `generate` → SQL). Two axes matter most to *this* template: whether
the runner can even express `CONCURRENTLY` (its transaction model), and whether it
keeps the `drizzle/*.sql` artifact the **safety guard** is built on.

| Runner | `CONCURRENTLY`? (tx model) | Authoring in `schema.ts`? | Keeps `drizzle/*.sql` (guard works) | Zero-downtime expand/contract native | ADR-0005 conflict | Weight / maturity |
|---|---|---|---|---|---|---|
| **`drizzle-kit migrate`** (built-in) | ❌ one tx for all pending | ✅ | ✅ | ❌ | none | minimal — already `drizzle` |
| **`drizzle-orm migrate()`** (programmatic) | ❌ same dialect | ✅ | ✅ | ❌ | none | minimal — you call it from code |
| **Custom applier** (`generate`-only + `postgres.js`) | ✅ you own the tx boundaries | ✅ | ✅ | ❌ (done by hand, expand/contract) | none | low — but you own the journal + failure semantics |
| **`node-pg-migrate` / `dbmate`** (generic SQL) | ✅ per-migration "no transaction" flag | ⚠️ authoring in `drizzle`, migrations in their own dir/journal | ⚠️ SQL yes, but their format, not `drizzle/*.sql` | ❌ | ⚠️ **introduce down-migrations** | low, mature — but a **second system** |
| **Atlas** (Ariga) | ✅ `atlas:txmode none` per file | ⚠️ consumes the `drizzle` schema, or supersedes `generate` | ⚠️ its own versioned dir | partial (lint + planned apply) | ⚠️ its linter overlaps the guard | medium — second tool in the chain |
| **pgroll** (Xata) | ✅ by construction | ❌ own YAML/JSON ops; `drizzle` demoted to a diff source | ❌ different artifact → **guard needs rework** | ✅ true zero-downtime (views over one table) | ⚠️ requires **down data-migrations** | high — new mental model |
| **reshape** | ✅ by construction (shadow schema) | ❌ own TOML/JSON ops; **no SQL import** (only a raw-SQL `custom` action that drops zero-downtime) | ❌ | ✅ | ⚠️ down-migrations | high + **less active than pgroll** |

### On the two "clean" middle options

- **Custom applier** is the smallest change that resolves the contradiction
  without giving up `CONCURRENTLY`: keep `generate`, replace only the ~15-line
  apply loop with one that runs flagged statements outside any transaction
  (honouring a `-- concurrent:` / `-- no-transaction:` marker), and teach the
  guard that one marker — the same pattern ADR-0005 already uses for
  `-- contract:`. The `drizzle/*.sql` artifact and the guard survive intact; the
  cost is owning `__drizzle_migrations` compatibility and per-statement failure
  semantics (a mid-batch failure is no longer all-or-nothing).
- **`drizzle-kit migrate` as-is** is viable only if we accept blocking index
  builds (`ShareLock` for the whole build) and amend the skill to say
  "`CONCURRENTLY` is not available under our runner." Fine for small tables or a
  maintenance window; a real availability hit on large ones.

### On pgroll specifically

pgroll is the most powerful and the furthest from `drizzle` — worth stating
precisely because two things about it are easy to get wrong:

- **The "drizzle integration" is a conversion step, not native.** Since pgroll
  0.10 the flow is `schema.ts → drizzle-kit generate → SQL → pgroll convert →
  YAML/JSON`. The conversion is **lossy**: statements are not aggregated into
  single pgroll operations, and the result **must be hand-edited to add up *and*
  down data-migrations** — and pgroll *requires* the down side, which ADR-0005
  forbids. So `schema.ts` stops being the single source of truth.
- **The "two schemas" do not double disk.** The old and new schema are two
  **view** namespaces over the **same physical table** (near-zero storage). The
  real, transient cost is **shadow columns**: a changed column gets a new physical
  column (e.g. `_pgroll_new_description`) backfilled and kept in sync by triggers,
  so you carry the *changed column(s)* twice for the migration window — released
  at `pgroll complete` (contract). It is `1 table + duplicated changed-column(s)`,
  not `2× the table`. Significant only when rewriting a large column over many
  rows, and temporary.

### On reshape specifically

reshape shares pgroll's views-over-one-table model but is weaker on the axis that
matters here: it has **no SQL import** — no equivalent of `pgroll convert`.
Migrations are authored as declarative TOML/JSON actions (`add_column`,
`rename_table`, …), and that declarative form is *what buys* the zero-downtime
guarantee. Its `custom` action can run raw SQL, but the docs warn it provides **no
zero-downtime guarantee** — it just runs what you give it. So feeding
drizzle-generated SQL into reshape either loses the whole point (via `custom`) or
means rewriting every migration by hand in reshape's format. On "extract from
drizzle to feed another transport", **pgroll ≫ reshape**.

## Reading of the candidates

The template's existing investment — `schema.ts` authoring and a guard keyed off
`drizzle/*.sql` — makes the **light** end (`drizzle-kit migrate`, then the custom
applier) integrate cleanly, and the **heavy** end (pgroll/reshape) expensive,
because they discard the artifact the guard is built on. `node-pg-migrate` /
`dbmate` and pgroll/reshape all pull in **down-migrations**, which cut against an
explicit ADR-0005 decision. The **custom applier** is the current front-runner on
paper — but confirming that (and the "extract from drizzle for another transport"
question) is exactly the deep comparison deferred to
[#14](https://github.com/LunetteOrg/starter/issues/14).

## Does the template need to decide now?

- **The runner choice is deferrable.** There is nothing to run yet; the safety
  guard is self-arming and inert until the first migration lands.
- **The contradiction is not deferrable to record.** Today the skill and ADR-0005
  tell authors to do things the likely runner cannot execute. If the first db
  package wires `drizzle-kit migrate` naively, `CONCURRENTLY` will pass review
  (the guard allows it) and fail at apply time in production.
- **Recommendation:** treat this as a real decision moment — *deferred but
  flagged.* Until the db package is scoped and [#14](https://github.com/LunetteOrg/starter/issues/14)
  resolves into an ADR-0005 section, note in the `postgres` skill that
  `CONCURRENTLY` depends on an unchosen runner, so nobody ships it assuming it
  works.

## Open follow-up (tracked in [#14](https://github.com/LunetteOrg/starter/issues/14))

The deep comparison this doc sets up, deferred by design:

- Bench each candidate against the two axes above **plus** rollback model,
  operational weight, and the destructive-change gate (whose linter owns it).
- **Research question:** can we extract everything needed from drizzle's generated
  migrations — the `.sql` files, the `--> statement-breakpoint` splits, the
  `__drizzle_migrations` journal — to feed *another* transport, while keeping
  `schema.ts` as the single source of truth? If yes, we get `CONCURRENTLY` and a
  stronger engine without abandoning drizzle authoring. Note the transports differ
  on this already: pgroll offers a (lossy) `convert` from SQL, reshape offers no
  SQL import at all — so the answer is per-transport, not general.
- Re-verify the single-transaction wrapper on the drizzle version the db package
  pins, and whether `drizzle-kit` has added a per-migration no-transaction opt-out.
