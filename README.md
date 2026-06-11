# Lunette Starter

Template TypeScript monorepo (Turbo + pnpm) con Biome, Lefthook, commitlint, drizzle/postgres + testcontainers, deploy Render via Blueprint, CI GitHub Actions.

## Crea un nuovo progetto

```bash
npm create @lntt my-app
# oppure
pnpm create @lntt my-app
```

Poi:

```bash
cd my-app
pnpm install
pnpm infra:up
pnpm dev
```

Lo scaffolding fa il rename dei placeholder (`@starter/*`, credenziali DB, nomi servizi Render) col nome scelto, ed esegue `git init` + primo commit.

Il CLI è [`@lntt/create`](https://www.npmjs.com/package/@lntt/create) ([sorgente](https://github.com/LunetteOrg/create-lunette)).

## Cosa c'è dentro

- **Tooling**: Biome (lint+format), Lefthook (pre-commit lint+typecheck, commit-msg commitlint), pnpm 10.16.1, Turbo 2.x
- **Enforcement architetturale**: import boundaries per layer via Biome `noRestrictedImports` (domain/use-cases/routes, glob su `apps/*`), ban di `Date` a favore di `Temporal`, plugin GritQL per i test e2e, helper per architecture test in `@starter/test-utils` — vedi [ADR-0004](./docs/adr/0004-import-boundaries-enforcement.md)
- **ADR**: decisioni architetturali in [`docs/adr/`](./docs/adr/README.md)
- **Pacchetti condivisi** (`packages/`):
  - `@starter/biome-config` — preset Biome
  - `@starter/typescript-config` — `base.json` + `browser.json` (strict ES2024)
  - `@starter/test-utils` — `createTestDb` + plugin Vitest (testcontainers + Postgres + transaction rollback)
  - `@starter/ui`, `@starter/ui-tokens` — scaffold vuoti
- **Infra**: `compose.yaml` (Postgres 17), `render.yaml` Blueprint (web + DB managed, autoDeploy)
- **CI**: `.github/workflows/ci.yml` (lint+typecheck+test, job e2e disabilitato finché non c'è un'app target)
- **DX**: `.devcontainer/` (Node 24, Docker-in-Docker), `.vscode/` (default formatter Biome)

## Convenzioni

Vedi [`CONTRIBUTING.md`](./CONTRIBUTING.md) per naming branch/commit/file e regole di import. Vedi [`CLAUDE.md`](./CLAUDE.md) per le regole architetturali rilevanti agli agenti AI.
