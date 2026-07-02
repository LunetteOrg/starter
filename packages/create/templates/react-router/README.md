# Lunette Starter

TypeScript monorepo template (Turbo + pnpm) with Biome, Lefthook, commitlint, drizzle/postgres + testcontainers, Render deploy via Blueprint, GitHub Actions CI.

## Create a new project

```bash
npm create @lntt my-app
# or
pnpm create @lntt my-app
```

Then:

```bash
cd my-app
pnpm install
pnpm infra:up
pnpm dev
```

Scaffolding renames the placeholders (`@starter/*`, DB credentials, Render service names) to the chosen name, and runs `git init` + the first commit.

The CLI is [`@lntt/create`](https://www.npmjs.com/package/@lntt/create) ([source](https://github.com/LunetteOrg/create-lunette)).

## What's inside

- **Tooling**: Biome (lint+format), Lefthook (pre-commit lint+typecheck, commit-msg commitlint), pnpm 10.16.1, Turbo 2.x
- **Architectural enforcement**: per-layer import boundaries via Biome `noRestrictedImports` (domain/use-cases/routes, glob over `apps/*`), a ban on `Date` in favour of `Temporal`, a GritQL plugin for e2e tests, architecture-test helpers in `@starter/test-utils` — see [ADR-0002 (import boundaries)](./docs/adr/0002-architecture-and-boundaries.md#import-boundaries)
- **ADRs & guidances**: how the template is built lives in [`docs/adr/`](./docs/adr/README.md); recommended patterns for the app you build on it (not shipped) are in [`docs/guidances/`](./docs/guidances/README.md)
- **Shared packages** (`packages/`):
  - `@starter/biome-config` — Biome preset
  - `@starter/typescript-config` — `base.json` + `browser.json` (strict ES2024)
  - `@starter/test-utils` — `createTestDb` + Vitest plugin (testcontainers + Postgres + transaction rollback)
  - `@starter/ui`, `@starter/ui-tokens` — empty scaffolds
- **Infra**: `compose.yaml` (Postgres 17), `render.yaml` Blueprint (web + managed DB, autoDeploy)
- **CI**: `.github/workflows/ci.yml` (lint+typecheck+test, e2e job disabled until there's a target app)
- **DX**: `.devcontainer/` (Node 24, Docker-in-Docker), `.vscode/` (default formatter Biome)

## Conventions

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for branch/commit/file naming and import rules. See [`CLAUDE.md`](./CLAUDE.md) for the architectural rules relevant to AI agents.
