---
status: accepted
date: 2026-07-02
tags: [template-model, contract]
---

# ADR-0002: What a Lunette template is

## Context

We will ship more than one template (today `react-router`; tomorrow perhaps
`hono`, `remix3`, `trpc`). Without a definition, "a Lunette template" degrades
into "some monorepo we happened to make". We need to state what is *invariant*
across every template versus what is the *identity of a variant* — and what the
templates enforce versus what they merely recommend.

## Decision

**A Lunette template = a shared base + a variant.**

### The shared base (invariant across every template)

The base is what you would copy unchanged when creating the next template — it is
what makes a repo recognizably *Lunette*:

1. **Monorepo substrate** — Turborepo + pnpm workspaces, Node 24 (native TS type
   stripping, no build tooling), `packages/*` + `apps/*` layout.
2. **Tooling baseline** — Biome (lint+format), Lefthook, commitlint (conventional
   commits), a uniform CI shape (lint + typecheck + test).
3. **Boundaries enforced + self-arming** — whatever architecture a template
   declares, its boundaries are **mechanically enforced** (Biome
   `noRestrictedImports` + architecture tests in `@starter/test-utils`) and
   **self-arming** (guards are inert until the code exists, then bite). *The shape
   of the boundaries is per-template; that they are enforced is invariant.*
4. **Decisions in the repo** — thematic numbered ADRs (`docs/adr/`) plus
   `docs/guidances/` for app-level recommendations; append-only once scaffolded; a
   *foundation to start aligned*, not a granular decision log.
5. ~~**Scaffolding contract** — the placeholder scheme, the `.lunette-template`
   marker, and the dotfile convention (see the scaffolding-contract ADR) so **one
   CLI scaffolds any template**.~~
   **Amended by [ADR-0008](./0008-drop-the-template-marker.md)**: the marker is
   gone. The contract is the placeholder scheme and the dotfile convention.

**Strong defaults** (shared unless a template has a concrete reason to diverge):
testcontainers-based testing (`withTestDb`, never mock the DB, migration-safety
guard) where there is a database; TypeScript `strict`; typed, FP-style error
handling over exceptions.

### The variant (the identity — and the name)

What varies is the **web framework** and the architecture it implies. The template
is **named by that axis** (`react-router`, later `hono`, `remix3`). Secondary axes
(ORM, deploy) enter the name only when a real collision appears — YAGNI. The
`react-router` template's own choice is a hexagonal/layered architecture with
Drizzle + Postgres + Render, recorded in *its* `docs/adr/`.

### Enforced boundaries vs recommended vocabulary

- **Enforced** (by machine, self-arming): the *structural* boundaries — dependency
  rule, domain purity, layer boundaries. You cannot violate them by accident.
- **Recommended** (guidance, not enforced): higher-level design vocabulary —
  tactical DDD (aggregates, value objects, domain events), Gang-of-Four patterns,
  Clean Code / SOLID, functional-programming principles. These are modelling
  discipline, not mechanically checkable; they live in `docs/guidances/`, opinionated
  and contextual ("when yes / when no"), never a reading list.
- **The bridge**: a template may **concretize a guidance into an enforced rule**.
  Example: FP-style typed errors are a *recommended* principle; the `react-router`
  template promotes it to an *enforced* rule (`errore`, `throw` banned).

## Consequences

- \+ "Is this a Lunette template?" has a checkable answer: it has the base (1–5).
- \+ A new framework template starts from the base and only rewrites the variant.
- \+ We are honest: we enforce only what is enforceable, and recommend the rest —
  no template pretends to mechanize modelling discipline.
- − The base is currently **duplicated** in each template, not shared code (see the
  create-vite model ADR); keeping bases in sync is manual until patterns stabilize
  and we extract shared packages.
- − The enforced/recommended line is a judgement call per rule; reviews must place
  each new decision on the right side (or concretize it deliberately).
