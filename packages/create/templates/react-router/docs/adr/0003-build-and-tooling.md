---
status: accepted
date: 2026-07-02
tags: [build, tooling, biome, turbo]
---

# ADR-0003: Build & tooling

This ADR records the template's build and tooling foundation: the baseline tech stack (runtime, monorepo, framework, database, and supporting tools) and how Turborepo handles environment-variable passthrough.

## Tech stack baseline

### Context

The starter targets complex full-stack TypeScript applications built by small teams (2 devs scaling to 5+), with heavy AI-assisted development. It needs opinionated defaults that favour web standards (portability to e.g. Cloudflare Workers), testability, and "one tool per concern".

### Decision

| Concern | Choice |
|---|---|
| Runtime | Node.js 24 LTS — native type stripping; scripts run with `node` directly, never `tsx`/`ts-node` |
| Monorepo | pnpm workspaces + Turborepo; `moduleResolution: bundler` for bundled packages (see [module resolution & import convention](#module-resolution--import-convention)), no build step for internal packages |
| Bundler | Vite (Rolldown) |
| Web framework | React Router v7 — loaders/actions, server-rendered, progressive enhancement |
| Webhooks / external HTTP | Hono |
| Database | Postgres only; Drizzle ORM + Drizzle Kit migrations |
| Date/time | `Temporal` everywhere; `Date` is banned (see [import boundaries](./0002-architecture-and-boundaries.md#import-boundaries)) |
| Lint/format | Biome (single tool) |
| Tests | Vitest + Testcontainers + Playwright (see [testing strategy](./0004-testing.md#testing-strategy)) |
| Git hooks | Lefthook + commitlint (conventional commits) |
| Styling | CSS Modules for components + Tailwind for utilities |
| TypeScript | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns` |
| Deploy | Container-based. The template ships a Render Blueprint (`render.yaml`); self-hosted VPS (Uncloud/Kamal) is a documented alternative |

Deferred until a concrete trigger fires:

| Deferred | Un-defer signal |
|---|---|
| Caching (Redis) | p95 response > 500ms on a read-heavy route |
| Jobs queue (pg-boss, see [jobs and cron](../guidances/app-infrastructure.md#jobs-and-cron)) | First use case that must run async |
| Rate limiting | First public unauthenticated endpoint |
| External API layer (tRPC vs Hono+OpenAPI vs ElysiaJS) | First non-TS or third-party API consumer |

### Consequences

- \+ Lean start; every deferred item has an explicit signal, so "add it later" is a plan rather than a hope.
- \+ Web-standard surface (`Request`/`Response`, `getLoadContext`) keeps a Workers migration realistic.
- − Postgres-only means jobs, caching and sessions all lean on the same database until triggers fire.

## Turbo env passthrough

### Context

Turborepo 2.x runs in **strict** env-mode by default: a task's subprocess only
receives the env vars Turbo is told to pass (`globalPassThroughEnv` /
`passThroughEnv` / `env`) plus a built-in system list. Narrowing
`globalPassThroughEnv` to an explicit allowlist looks like good secrets hygiene,
but it filters the variables our toolchain needs at runtime — notably
`DOCKER_HOST`, `DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH` and `TESTCONTAINERS_*`.
Integration tests use Testcontainers, so an allowlist that omits these passes in
CI (default Docker socket) but breaks `turbo test` on a developer machine using
colima, podman, or a non-default Docker context — "green in CI, broken on the
laptop". This question comes up repeatedly.

### Decision

Keep `globalPassThroughEnv: ["*"]` in `turbo.json`. Do not narrow it to an
explicit allowlist.

Secrets discipline is enforced where it actually matters, not at the Turbo
boundary: env vars are read only in `config/env.ts` ([secrets](../guidances/app-infrastructure.md#secrets)). The cost of
maintaining a passthrough allowlist (chasing every tool's runtime env on every
machine) is not worth the marginal benefit over that boundary.

### Consequences

- \+ Local integration tests work regardless of the developer's Docker setup.
- \+ One fewer moving part; no allowlist to keep in sync with the toolchain.
- − Turbo's cache keys don't gain the precision an explicit `env` list would
  give; declare task-specific `env`/`inputs` where cache correctness matters.
- − Relies on the [secrets](../guidances/app-infrastructure.md#secrets) boundary (env read only in `config/env.ts`) as the real secrets
  boundary.

## Module resolution & import convention

### Context

The stack splits by runtime. The UI runs behind the bundler (Vite/Rolldown),
where a relative import can be extensionless. But this project also runs plain
TypeScript **directly under Node** — native type stripping, scripts invoked with
`node`, never `tsx`/`ts-node` — and Node ≥24 is LTS with type stripping on by
default. Under native ESM the file extension in an `import` is imposed by **Node's
resolver, not TypeScript**: extensionless ESM resolution does not exist, and no TS
option makes the extension optional (`import './file.ts'`, not `'./file'`).
TypeScript 7 moves the same way — TS 6.0+ assumes `allowImportingTsExtensions`.

Two idioms could coexist (extensionless in the UI, explicit under Node). One
convention is simpler to hold and to move code between.

### Decision

Write relative imports with the **explicit source extension** — `./x.ts`,
`./x.tsx` — everywhere, UI included. Extensionless imports and the
`.js`-pointing-at-`.ts` workaround are both out.

Portability follows a gradient, and the point of the convention is to keep the
portable end genuinely portable:

- **Domain and non-UI libraries are Node-first.** They carry **no bundler-only
  imports** — no JSX, no `.css`/asset/`?raw`/`virtual:` imports — so `node` can
  run them directly. These packages use `moduleResolution: nodenext` (with
  `rewriteRelativeImportExtensions` where they emit).
- **UI / app packages stay on the bundler** (`moduleResolution: bundler`). The
  explicit extension here is consistency, **not** portability.

**Extension ≠ portability.** Writing `.ts` does not make a React component
Node-runnable — JSX and CSS/asset imports do the binding. What keeps the domain
runnable under Node is the *absence* of bundler imports, not the extension. The
convention aligns writing style and strictness across the tree; portability is
earned separately, by keeping the domain layer free of bundler dependencies.

### Consequences

- \+ One import style across UI, libraries, and Node scripts; moving a module
  between runtimes settles the extension axis up front.
- \+ Aligned with where Node and TypeScript are going, not the bundler holdover.
- − On UI code the explicit extension is cosmetic — it buys no portability, only
  consistency.
- − Generated code (React Router typegen, Storybook) stays extensionless, so the
  tree is mixed by design; a lint rule that enforces the convention must exclude
  generated directories.
- − `moduleResolution` is not uniform: `bundler` for UI/bundled packages,
  `nodenext` for Node-first domain/libraries. This split is the whole point.

