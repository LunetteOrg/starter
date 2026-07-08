# ADR-0007: Product-decision and reference spaces

- Status: accepted
- Date: 2026-07-08

## Context

A real project makes many **product & design** decisions, and often starts from
**prior material** — a legacy app, database dumps, prototypes. Two gaps in the
scaffold:

1. ADRs are deliberately a *small, thematic foundation*, not a granular per-decision
   log ([ADR-0001](./0001-recording-decisions.md)). Product choices are numerous and
   frequent; forcing them into ADRs would either bloat the architecture record or
   leave them unrecorded.
2. Reference material is heterogeneous (foreign languages, SQL dumps, prototype
   exports), potentially large, and must never enter the app's build/lint/test —
   yet it should be explorable from the same clone, so the evolution reads in one
   place.

Product decisions also need to be **reviewable by non-technical stakeholders**, who
won't read markdown in a repo.

## Decision

Ship three spaces in every scaffolded project:

- **`docs/product/`** — the granular **product-decision log** (PDR), one markdown
  file per decision, append-only once scaffolded (same immutability as ADRs). This
  is the *source of truth* for product/design choices, complementary to `docs/adr/`.
- **`reference/`** — a top-level **quarantine** for raw input. Committed (the
  reference travels with the code) but excluded from the toolchain: it is no
  workspace package (so Turbo/pnpm ignore it) and is added to Biome's ignore list,
  so `pnpm lint`/`format` never touch it.
- **A `Product/` section in the design-system Storybook** — the **review surface**.
  One MDX page per PDR imports the markdown `?raw` and renders it with the
  `Markdown` block (no duplication), embedding the interactive prototype and the
  legacy "before" from `reference/`. Stakeholders review there;
  [the product-decisions guidance](../guidances/product-decisions.md) covers the
  comment backend (Chromatic by default).

These spaces ship as **form**: the READMEs, the PDR template, one example Storybook
page, the Biome ignore, and the `product-decision` / `product-check` skills. The
decisions, the reference material and the review pages are this project's content
to fill in.

## Consequences

- \+ Product decisions get a home that fits their cadence without diluting the
  architecture ADRs.
- \+ The whole evolution — legacy → prototype → decision — is explorable from one
  clone and reviewable by non-technical people on one Storybook screen.
- \+ Reference material can't break CI: it's outside every tool by construction.
- − Another convention to learn (ADR vs PDR vs reference); the READMEs and
  `product-check` carry that weight.
- − `reference/` is committed, so large dumps live in git history forever — the
  README calls this out and says to link out instead when a dump is huge.
