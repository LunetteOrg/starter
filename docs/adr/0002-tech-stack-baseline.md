# ADR-0002: Tech stack baseline

- Status: accepted
- Date: 2026-03-17

## Context

The starter targets complex full-stack TypeScript applications built by small teams (2 devs scaling to 5+), with heavy AI-assisted development. It needs opinionated defaults that favour web standards (portability to e.g. Cloudflare Workers), testability, and "one tool per concern".

## Decision

| Concern | Choice |
|---|---|
| Runtime | Node.js 24 LTS — native type stripping; scripts run with `node` directly, never `tsx`/`ts-node` |
| Monorepo | pnpm workspaces + Turborepo; `moduleResolution: bundler`, no build step for internal packages |
| Bundler | Vite (Rolldown) |
| Web framework | React Router v7 — loaders/actions, server-rendered, progressive enhancement |
| Webhooks / external HTTP | Hono |
| Database | Postgres only; Drizzle ORM + Drizzle Kit migrations |
| Date/time | `Temporal` everywhere; `Date` is banned (see ADR-0004) |
| Lint/format | Biome (single tool) |
| Tests | Vitest + Testcontainers + Playwright (see ADR-0006) |
| Git hooks | Lefthook + commitlint (conventional commits) |
| Styling | CSS Modules for components + Tailwind for utilities |
| TypeScript | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns` |
| Deploy | Container-based. The template ships a Render Blueprint (`render.yaml`); self-hosted VPS (Uncloud/Kamal) is a documented alternative |

Deferred until a concrete trigger fires:

| Deferred | Un-defer signal |
|---|---|
| Caching (Redis) | p95 response > 500ms on a read-heavy route |
| Jobs queue (pg-boss, see ADR-0011) | First use case that must run async |
| Rate limiting | First public unauthenticated endpoint |
| External API layer (tRPC vs Hono+OpenAPI vs ElysiaJS) | First non-TS or third-party API consumer |

## Consequences

- \+ Lean start; every deferred item has an explicit signal, so "add it later" is a plan rather than a hope.
- \+ Web-standard surface (`Request`/`Response`, `getLoadContext`) keeps a Workers migration realistic.
- − Postgres-only means jobs, caching and sessions all lean on the same database until triggers fire.
