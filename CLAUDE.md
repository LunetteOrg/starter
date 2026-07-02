# CLAUDE.md — the create monorepo

## What this repo is

The **create monorepo**: it holds `@lntt/create` (the scaffolder) and the Lunette
**templates**. It is *not* itself a Lunette template — it is the system that ships
them. Read [`docs/adr/`](./docs/adr/README.md) before changing anything the ADRs
cover, especially [what a Lunette template is](./docs/adr/0002-what-is-a-lunette-template.md).

## Two levels — do not confuse them

- **This monorepo** governs the *templates system*: the CLI, the template model,
  the scaffolding contract. Its decisions live in `docs/adr/`.
- **Each template** (`packages/create/templates/<framework>/`) is a **self-contained
  project** with its *own* tooling (its own `biome.json`, `lefthook.yml`, `docs/adr/`,
  `.claude/`, …) and its *own* application architecture. Those files are template
  content — do **not** "fix" them to match this repo, and do not import this repo's
  conventions into them.
- Templates are **duplicated, not shared** (ADR-0003). We extract shared packages
  only once patterns prove themselves — not before (YAGNI).

## Working on the CLI

- `packages/create/bin/index.ts` — TypeScript, run directly on **Node ≥24** (native
  type stripping, no build step). `pnpm --filter @lntt/create test` scaffolds each
  template into a temp dir and asserts the result.
- Tooling here is scoped to the CLI: Biome only lints `packages/create/{bin,test}`
  (never the templates), plus lefthook + commitlint. `pnpm lint`, `pnpm typecheck`,
  `pnpm test`.

## The scaffolding contract

If you change a placeholder, the `.lunette-template` marker, or the dotfile scheme
([ADR-0004](./docs/adr/0004-scaffolding-contract.md)), change the **CLI and every
template together** — they live in one repo, so it is one PR.

## Adding a template

A variant is a folder under `packages/create/templates/`, named by its **web
framework** (`react-router`, later `hono`, …). It must honour the shared base
([ADR-0002](./docs/adr/0002-what-is-a-lunette-template.md)) and the scaffolding
contract; then it is selectable via `--template <name>`.

## Conventions

- Conventional commits; no `Co-Authored-By:` / "Generated with …" trailers (the
  `commit-msg` hook strips them).
- Trunk-based, short-lived branches, one PR per change.

## Key paths

- ADRs (this system): `docs/adr/`
- The CLI: `packages/create/bin/index.ts`
- Templates: `packages/create/templates/<framework>/`
