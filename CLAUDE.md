# CLAUDE.md — the Lunette starter

## What this repo is

The **Lunette starter**: it holds `@lntt/create` (the scaffolder) and the Lunette
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

- `packages/create/bin/index.ts` — TypeScript, run directly in-repo on **Node ≥24**
  (native type stripping, no build step). Published, it is **compiled to `dist/`**
  (`prepack`) — Node won't strip types under `node_modules` ([ADR-0005](./docs/adr/0005-publish-compiled-cli.md)).
  `pnpm --filter @lntt/create test` scaffolds each template into a temp dir and
  asserts the result.
- Tooling here is scoped to the CLI: Biome only lints `packages/create/{bin,test}`
  (never the templates), plus lefthook + commitlint. `pnpm lint`, `pnpm typecheck`,
  `pnpm test`.

## Releasing

**npm publish happens in CI, never locally.** The flow:

1. Bump `packages/create/package.json` and commit `chore(release): @lntt/create X.Y.Z`
   directly on `main` (releases don't go through a PR).
2. `gh release create vX.Y.Z --generate-notes` — the tag **must** match the package
   version. **Always** pass `--generate-notes`: every release must ship generated
   notes (the merged-PR changelog since the previous tag).

Publishing a GitHub Release triggers `.github/workflows/release.yml`, which runs
`pnpm test` as a gate, verifies `tag == package version`, and publishes via npm
**OIDC trusted publishing** (`--provenance`, no NPM token; [ADR-0005](./docs/adr/0005-publish-compiled-cli.md)).
Do not run `npm publish` by hand.

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
