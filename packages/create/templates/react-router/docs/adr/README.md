# Architecture Decision Records

Architectural decisions for this starter are recorded as ADRs — **thematic**, one
file per area, in [MADR](./template.md) format (YAML frontmatter with
`status`/`date`/`deciders`/`tags` for search, then Context / Decision /
Alternatives considered / Consequences). See
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

1. Copy [`template.md`](./template.md) to `NNNN-short-kebab-title.md` (next free number),
   or extend an existing thematic ADR with a new `## ` section.
2. Keep it short: Context (why a decision was needed), Decision (what we do),
   Alternatives considered (fairly represented), Consequences (positive,
   negative/accepted risks, and the triggers that should reopen the decision).
   Fill the frontmatter `tags` — that's what makes the log searchable.
3. Once a project is scaffolded from this template, ADRs are append-only: never
   rewrite an accepted decision to mean something different — write a new one and
   mark the old as `superseded by ADR-NNNN`. (This immutability applies to
   derived projects, not to constructing the template itself — see ADR-0001.)
4. Add a row to the index above.

App-level patterns the template does **not** ship (auth, feature flags, secrets,
jobs, graceful shutdown) are recommendations, not decisions — they live in
[`../guidances/`](../guidances/README.md), not here.
