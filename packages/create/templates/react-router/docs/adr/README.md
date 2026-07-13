# Architecture Decision Records

Architectural decisions are recorded as ADRs in [MADR](./template.md) format (YAML
frontmatter with `status`/`date`/`deciders`/`tags` for search, then Context /
Decision / Alternatives considered / Consequences). The log has two parts: a
**thematic seed** — the numbered `0001-000N` files below, the foundation shipped
with the template, one file per area — and the **evolution**: every new decision
you make is its own atomic, dated file (`YYYY-MM-DD-title.md`), never a new
section inside a seed file. Dated ids don't contend for "the next number", so
concurrent PRs never silently collide. See
[ADR-0001](./0001-recording-decisions.md) for the process (including how ADRs
relate to the [`../guidances/`](../guidances/README.md) recommendations).

| ADR | Title | Status |
|---|---|---|
| [0001](./0001-recording-decisions.md) | Recording decisions | accepted |
| [0002](./0002-architecture-and-boundaries.md) | Architecture & boundaries | accepted |
| [0003](./0003-build-and-tooling.md) | Build & tooling | accepted |
| [0004](./0004-testing.md) | Testing | accepted |
| [0005](./0005-data-and-migrations.md) | Data & migrations | accepted |
| [0006](./0006-design-system.md) | Design system | accepted |
| [0007](./0007-product-and-reference-spaces.md) | Product-decision & reference spaces | accepted |

## Writing a new ADR

1. Copy [`template.md`](./template.md) to `YYYY-MM-DD-short-kebab-title.md` —
   today's date, one decision per file. Do **not** extend a seed file with a new
   `## ` section: the seed is the shipped foundation, the log grows as dated files.
2. Keep it short: Context (why a decision was needed), Decision (what we do),
   Alternatives considered (fairly represented), Consequences (positive,
   negative/accepted risks, and the triggers that should reopen the decision).
   Fill the frontmatter `tags` — that's what makes the log searchable.
3. Once a project is scaffolded from this template, ADRs are append-only: never
   rewrite an accepted decision to mean something different — write a new dated ADR
   and mark the old as `superseded by YYYY-MM-DD-…` (down to the `## ` section
   level of a seed file: mark the section superseded, leave it in place, add the
   replacement as a new file). This immutability applies to derived projects, not
   to constructing the template itself — see ADR-0001.
4. Add a row to the index above (dated ADRs append below the seed).

App-level patterns the template does **not** ship (auth, feature flags, secrets,
jobs, graceful shutdown) are recommendations, not decisions — they live in
[`../guidances/`](../guidances/README.md), not here.
