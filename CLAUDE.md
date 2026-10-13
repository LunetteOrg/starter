# CLAUDE.md — the Lunette starter

## What this repo is

The **Lunette starter**: it holds `@lntt/create` (the scaffolder) and the Lunette
**templates**. It is *not* itself a Lunette template — it is the system that ships
them. Read [`docs/adr/`](./docs/adr/README.md) before changing anything the ADRs
cover, especially [the template model](./docs/adr/template-model.md).

## Two levels — do not confuse them

- **This monorepo** governs the *templates system*: the CLI, the template model,
  the scaffolding contract. Its decisions live in `docs/adr/`.
- **Each template** (`packages/create/templates/<framework>/`) is a **self-contained
  project** with its *own* tooling (its own `biome.json`, `lefthook.yml`, `docs/adr/`,
  `.claude/`, …) and its *own* application architecture. Those files are template
  content — do **not** "fix" them to match this repo, and do not import this repo's
  conventions into them.
- Templates are **duplicated, not shared** ([template model](./docs/adr/template-model.md#templates-are-folders-bundled-inside-the-cli)). We extract shared packages
  only once patterns prove themselves — not before (YAGNI).

**Two decision logs, one rule.** `docs/adr/` at this root holds decisions about the
templates system; `packages/create/templates/*/docs/adr/` (and `docs/product/`) hold a
template's own, and travel into every project scaffolded from it. Both are one file
per subject, **corrected in place**, with rejected options in *Discarded directions*
(the `decisions` skill; [recording](./docs/process/recording.md)). A decision is
filed by what it governs, not by where it was discussed.

## Working on the CLI

- `packages/create/bin/index.ts` — TypeScript, run directly in-repo on **Node ≥24**
  (native type stripping, no build step). Published, it is **compiled to `dist/`**
  (`prepack`) — Node won't strip types under `node_modules` ([CLI runtime and publishing](./docs/adr/cli-runtime-and-publishing.md)).
  `pnpm --filter @lntt/create test` scaffolds each template into a temp dir and
  asserts the result.
- Tooling here is scoped to this repo's own packages: Biome lints
  `packages/create/{bin,test}` and `packages/project-config/` (never the templates),
  plus lefthook + commitlint. `pnpm lint`, `pnpm typecheck`, `pnpm test` (every
  package).

## Releasing

**npm publish happens in CI, never locally.** The flow:

1. Bump `packages/create/package.json` and commit `chore(release): @lntt/create X.Y.Z`
   directly on `main` (releases don't go through a PR).
2. `gh release create vX.Y.Z --generate-notes` — the tag **must** match the package
   version. **Always** pass `--generate-notes`: every release must ship generated
   notes (the merged-PR changelog since the previous tag).
3. Then **hand-integrate** what the generator misses: `--generate-notes` lists
   merged PRs only, so add any user-facing change that landed as a direct commit
   (`git log vPREV..vX.Y.Z --no-merges`) via `gh release edit vX.Y.Z --notes …`.
   Skip the `chore(release)` bump and repo-internal commits (not shipped).

Publishing a GitHub Release triggers `.github/workflows/release.yml`, which runs
`pnpm test` as a gate, verifies `tag == package version`, and publishes via npm
**OIDC trusted publishing** (`--provenance`, no NPM token; [CLI runtime and publishing](./docs/adr/cli-runtime-and-publishing.md)).
Do not run `npm publish` by hand.

## The scaffolding contract

If you change a placeholder or the dotfile scheme ([scaffolding contract](./docs/adr/scaffolding-contract.md)),
change the **CLI and every template together** — they live in one repo, so it is
one PR.

## Adding a template

A variant is a folder under `packages/create/templates/`, named by its **web
framework** (`react-router`, later `hono`, …). It must honour the shared base
([template model](./docs/adr/template-model.md)) and the scaffolding
contract; then it is selectable via `--template <name>`.

## Conventions

- Conventional commits; no `Co-Authored-By:` / "Generated with …" trailers (the
  `commit-msg` hook strips them).
- Trunk-based, short-lived branches, one PR per change.

## Key paths

- ADRs (this system): `docs/adr/`
- The CLI: `packages/create/bin/index.ts`
- Templates: `packages/create/templates/<framework>/`
- Project configuration: `.agents/config.jsonc`, read and edited through
  `packages/project-config/` (`lntt-config get <key>`; never `jq` or `JSON.parse`,
  the file has comments)
