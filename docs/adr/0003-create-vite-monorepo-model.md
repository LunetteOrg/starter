# ADR-0003: Templates as bundled folders (the create-vite model)

- Status: accepted
- Date: 2026-07-02

## Context

`@lntt/create` needs to hand out one of several templates, each a full monorepo.
An earlier design had the CLI `git clone` a separate `starter` repo at runtime —
which coupled two repos, meant a template change plus a CLI change were two PRs,
and gave no way to offer variants. We want variants (issue #3) and a single place
to reason about them.

## Decision

Adopt the shape `create-vite` / `create-next-app` use: **template variants are
folders bundled inside the CLI package**, copied verbatim.

```
packages/create/
  bin/index.ts          # the CLI (TypeScript, run directly on Node >=24)
  templates/
    react-router/       # a full Lunette template
    <framework>/        # a variant = another folder
```

- **Bundled, not cloned**: templates ship in the npm tarball (`files: ["templates"]`),
  so the template is versioned *with* the CLI — reproducible, offline, one PR
  changes both. Cost: a template change requires publishing a new CLI version.
- **A variant is a folder.** Add `templates/<name>/` and it is selectable
  (`--template <name>` or the interactive prompt). This delivers the multi-template
  goal (issue #3).
- **Named by the varying axis** (the web framework): `react-router`, later `hono`,
  `remix3`. Secondary axes (ORM, deploy) enter a name only on a real collision.
- **Duplication now, shared packages later.** Each template folder carries its own
  copy of the base (its own `biome.json`, `lefthook.yml`, `docs/adr/`, …). We do
  **not** pre-factor a shared base; we extract shared packages only once patterns
  have proven themselves across templates — YAGNI, the same stance the templates
  themselves take.
- **Workspace exclusion.** The outer `pnpm-workspace.yaml` globs only `packages/*`,
  so template folders (`packages/create/templates/**`) are never pulled into this
  repo's workspace. Each template is a self-contained monorepo you develop from
  inside its own folder.

## Consequences

- \+ Variants are trivial to add; the CLI and templates evolve together in one repo.
- \+ Scaffolding is offline and reproducible for a given CLI version.
- \+ No "exclude myself" absurdity — the CLI's files never live among template files.
- − A template change ships only when the CLI is republished (no more "always
  latest main").
- − The base is duplicated across templates until we extract shared packages;
  cross-template drift is a manual concern (mitigated by each template's own CI).
- − Developing a template happens inside its folder, not from the repo root.
