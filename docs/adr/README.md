# Architecture Decision Records

Architectural decisions for this starter are recorded as ADRs — one decision per file, in [MADR-lite](./template.md) format. See [ADR-0001](./0001-record-architecture-decisions.md) for the process.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](./0001-record-architecture-decisions.md) | Record architecture decisions as ADRs | accepted |
| [0002](./0002-tech-stack-baseline.md) | Tech stack baseline | accepted |
| [0003](./0003-layered-architecture-composition-root.md) | Layered architecture with a composition root | accepted |
| [0004](./0004-import-boundaries-enforcement.md) | Import boundaries enforced by Biome and architecture tests | accepted |
| [0005](./0005-typed-errors-errore.md) | Typed errors with `errore` instead of exceptions | accepted |
| [0006](./0006-testing-strategy.md) | Testing strategy: unit, integration, e2e | accepted |
| [0007](./0007-expand-migrate-contract-migrations.md) | Expand-Migrate-Contract for schema migrations | accepted |
| [0008](./0008-feature-flags-two-layer.md) | Two-layer feature flags with preview links | accepted |
| [0009](./0009-auth-oslo-session-otp.md) | Auth with Oslo primitives and owned schema | accepted |
| [0010](./0010-secrets-management.md) | Secrets management via GitHub Secrets | accepted |
| [0011](./0011-jobs-and-cron.md) | Jobs and cron: pg-boss for business logic, GitHub Actions for ops | accepted |
| [0012](./0012-graceful-shutdown.md) | Graceful shutdown for long-lived Node processes | accepted |
| [0013](./0013-use-case-composition.md) | Use-case composition in the composition root | accepted |
| [0014](./0014-design-tokens-css-custom-properties.md) | Design tokens as CSS custom properties | accepted |
| [0015](./0015-storybook-design-system.md) | Storybook as the showcase for `packages/ui` | accepted |

## Writing a new ADR

1. Copy [`template.md`](./template.md) to `NNNN-short-kebab-title.md` (next free number).
2. Keep it short: Context (why a decision was needed), Decision (what we do), Consequences (trade-offs, both signs).
3. Never rewrite an accepted ADR to say something different — write a new one and mark the old as `superseded by ADR-NNNN`.
4. Add a row to the index above.
