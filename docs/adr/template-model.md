---
status: accepted
date: 2026-07-02
tags: [template-model, contract, cli, monorepo]
---

# The template model

## Context

`@lntt/create` hands out one of several templates, each a full monorepo: today
`react-router`, tomorrow perhaps `hono`, `remix3`, `trpc`. Two questions shape
every template. What makes a repo a *Lunette* template, as opposed to "some
monorepo we happened to make"? And how are templates stored and shipped so that
one CLI can offer all of them?

## Decision

### A template is a shared base plus a variant

#### The shared base

The base is what you would copy unchanged when creating the next template. It is
what makes a repo recognizably *Lunette*:

1. **Monorepo substrate**: Turborepo + pnpm workspaces, Node 24 (native TS type
   stripping, no build tooling), `packages/*` + `apps/*` layout.
2. **Tooling baseline**: Biome (lint + format), Lefthook, commitlint (conventional
   commits), a uniform CI shape (lint + typecheck + test).
3. **Boundaries enforced and self-arming**: whatever architecture a template
   declares, its boundaries are **mechanically enforced** (Biome
   `noRestrictedImports` + architecture tests in `@starter/test-utils`) and
   **self-arming** (guards are inert until the code exists, then bite). *The shape
   of the boundaries is per-template; that they are enforced is invariant.*
4. **Decisions in the repo**: a small set of thematic ADRs (`docs/adr/`) as a
   *foundation to start aligned*, a product-decision log (`docs/product/decisions/`)
   and `docs/guidances/` for app-level recommendations. Every log is one file per
   subject, corrected in place, the same rules as this repo's
   ([recording](../process/recording.md)).
5. **Scaffolding contract**: the placeholder scheme and the dotfile convention
   ([scaffolding contract](./scaffolding-contract.md)), so **one CLI scaffolds any
   template**.

**Strong defaults** (shared unless a template has a concrete reason to diverge):
testcontainers-based testing (`withTestDb`, never mock the DB, migration-safety
guard) where there is a database; TypeScript `strict`; typed, FP-style error
handling over exceptions.

#### The variant: the identity, and the name

What varies is the **web framework** and the architecture it implies. The template
is **named by that axis** (`react-router`, later `hono`, `remix3`). Secondary axes
(ORM, deploy) enter the name only when a real collision appears. The
`react-router` template's own choice is a hexagonal/layered architecture with
Drizzle + Postgres + Render, recorded in *its* `docs/adr/`.

#### Enforced boundaries vs recommended vocabulary

- **Enforced** (by machine, self-arming): the *structural* boundaries, that is the
  dependency rule, domain purity and layer boundaries. You cannot violate them by
  accident.
- **Recommended** (guidance, not enforced): higher-level design vocabulary, such as
  tactical DDD (aggregates, value objects, domain events), Gang-of-Four patterns,
  Clean Code / SOLID, functional-programming principles. These are modelling
  discipline, not mechanically checkable; they live in `docs/guidances/`,
  opinionated and contextual ("when yes / when no"), never a reading list.
- **The bridge**: a template may **concretize a guidance into an enforced rule**.
  Example: FP-style typed errors are a *recommended* principle; the `react-router`
  template promotes it to an *enforced* rule (`errore`, `throw` banned).

### Templates are folders bundled inside the CLI

Template variants are **folders inside the CLI package**, copied verbatim: the
shape `create-vite` and `create-next-app` use.

```
packages/create/
  bin/index.ts          # the CLI (see cli-runtime-and-publishing.md)
  templates/
    react-router/       # a full Lunette template
    <framework>/        # a variant = another folder
```

- **Bundled, not cloned**: templates ship in the npm tarball (`files` includes
  `templates`), so a template is versioned *with* the CLI: reproducible, offline,
  and one PR changes both.
- **A variant is a folder.** Add `templates/<name>/` and it is selectable
  (`--template <name>` or the interactive prompt).
- **Duplication now, shared packages later.** Each template folder carries its own
  copy of the base (its own `biome.json`, `lefthook.yml`, `docs/adr/`, …). Shared
  packages are extracted only once a pattern has proven itself across projects.
- **Workspace exclusion.** The outer `pnpm-workspace.yaml` globs only
  `packages/*`, so template folders (`packages/create/templates/**`) are never
  pulled into this repo's workspace. Each template is a self-contained monorepo you
  develop from inside its own folder.

## Consequences

### Positive

- "Is this a Lunette template?" has a checkable answer: it has the base (1–5).
- A new framework template starts from the base and only rewrites the variant.
- We enforce only what is enforceable and recommend the rest; no template pretends
  to mechanize modelling discipline.
- Variants are trivial to add; the CLI and templates evolve together in one repo.
- Scaffolding is offline and reproducible for a given CLI version.

### Negative / accepted risks

- The base is **duplicated** in each template, not shared code. Keeping bases in
  sync is manual until shared packages are extracted.
- The enforced/recommended line is a judgement call per rule; reviews must place
  each new decision on the right side, or concretize it deliberately.
- A template change ships only when the CLI is republished.
- Developing a template happens inside its folder, not from the repo root.

### When to deviate (revisit triggers)

- A pattern of the base has proven itself in projects scaffolded from the template:
  extract it into a published package instead of duplicating it.
- A secondary axis (ORM, deploy) produces two templates with the same framework:
  the name gains that axis.

## Discarded directions

- **The CLI clones a separate `starter` repo at runtime.** It couples two repos,
  makes a template change plus a CLI change two PRs, and offers no way to ship
  variants.
- **A pre-factored shared base from day one.** It abstracts before any second
  template exists to show what is really shared.
