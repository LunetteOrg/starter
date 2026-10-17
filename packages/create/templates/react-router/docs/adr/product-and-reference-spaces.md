---
status: accepted
date: 2026-10-17
tags: [product, pdr, storybook, reference]
---

# Product-decision and reference spaces

## Context

A real project makes many **product & design** decisions, and often starts from
**prior material** — a legacy app, database dumps, prototypes. Two gaps in the
scaffold:

1. ADRs record **architecture**. Product & design choices are a different subject
   matter, numerous and frequent; folded into the architecture log they would bloat
   it or go unrecorded. They get their own log, split by subject matter.
2. Reference material is heterogeneous (foreign languages, SQL dumps, prototype
   exports), potentially large, and must never enter the app's build/lint/test —
   yet it should be explorable from the same clone, so the evolution reads in one
   place.

Product decisions also need to be **reviewable by non-technical stakeholders**, who
won't read markdown in a repo.

## Decision

Ship three spaces in every scaffolded project:

- **`docs/product/`**: the **product-decision log** (PDR), one file per product
  subject, corrected in place like the ADRs ([recording decisions](./recording-decisions.md)).
  It is the *source of truth* for product/design choices, next to `docs/adr/`.
- **`reference/`** — a top-level **quarantine** for raw input. Committed (the
  reference travels with the code) but excluded from the toolchain: it is no
  workspace package (so Turbo/pnpm ignore it) and is added to Biome's ignore list,
  so `pnpm lint`/`format` never touch it. A prototype that goes on changing in its own
  repository comes in as a squashed `git subtree` under `reference/prototypes/` and is
  updated with `git subtree pull --squash`, so every clone and worktree has it with no
  fetch and no access to its remote ([`reference/README.md`](../../reference/README.md)).
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
  README calls this out and says to link out instead when a dump is huge. A prototype
  kept as a subtree adds its tree to history at every update, squashed into one
  commit each time.

## Discarded directions

- **A git submodule for a prototype kept as reference.** It is empty in every new clone
  and worktree until fetched, which needs access to the prototype's remote; the
  shortcut of pointing it at a path on disk is refused by git (`protocol.file.allow`),
  and allowing that transport opens it to any submodule a repository declares.
- **A plain copy of the prototype's files.** Fine for one that will not change again,
  but it loses the link to the prototype's repository, so an update is a manual diff.
