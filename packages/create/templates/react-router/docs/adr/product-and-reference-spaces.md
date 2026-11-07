---
status: accepted
date: 2026-11-06
tags: [product, pdr, storybook, reference, compliance]
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

Two kinds of received material differ in how long they hold. Raw and intermediate
input (functional specs, analyses, prototype exports, legacy dumps) gets new
versions or goes stale. **Stable texts** the project must comply with (a statute, a
regulation, policy conditions, a client's brand guidelines) change only by a new
dated version, and decisions legitimately rest on them. A decision that links the
first kind ages with it, and its reader has to open the working document to
understand it.

Product decisions also need to be **reviewable by non-technical stakeholders**, who
won't read markdown in a repo.

## Decision

Ship four spaces in every scaffolded project:

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
- **`compliance/`** — a top-level space beside `reference/` for the **stable texts the
  project receives and must comply with**: legal texts (statute, regulations, policy
  conditions) and external norms such as a client's brand or design-system
  guidelines. They change only by a new version, so a decision can rest on one; how
  they are kept is in [`compliance/README.md`](../../compliance/README.md). It is
  excluded from the toolchain like `reference/`: the project receives these texts, it
  does not write them. A design system the project builds itself is its own code and
  decisions, not `compliance/`.
- **A `Product/` section in the design-system Storybook** — the **review surface**.
  One MDX page per PDR imports the markdown `?raw` and renders it with the
  `Markdown` block (no duplication), embedding the interactive prototype and the
  legacy "before" from `reference/`. Stakeholders review there;
  [the product-decisions guidance](../guidances/product-decisions.md) covers the
  comment backend (Chromatic by default).

### The rule on sources

- **A PDR cites `docs/` and `compliance/`, never `reference/`.** A fact it needs from
  `reference/` is written in the PDR, in words. The rule covers the PDR's text, not
  its Storybook review page, which keeps embedding the prototype and the legacy
  "before" from `reference/`. `packages/test-utils/src/meta-pdr-sources.spec.ts`
  enforces it, with the list of PDRs still waiting to be cleaned, which only shrinks
  (empty in a new project); `product-check` reports it.
- **An ADR cites `reference/` only as the proof of a measured fact**: the `path:line`
  of the legacy code it describes.
- **An external law not in the repository** is cited by its official link and the
  date of the version the decision rests on. Its text enters `compliance/` only when
  the decision depends on its exact wording.

These spaces ship as **form**: the READMEs, the PDR template, one example Storybook
page, the Biome ignore, the meta test, and the `product-decision` / `product-check`
skills. The decisions, the reference material, the compliance texts and the review
pages are this project's content to fill in.

## Consequences

- \+ Product decisions get a home that fits their cadence without diluting the
  architecture ADRs.
- \+ The whole evolution — legacy → prototype → decision — is explorable from one
  clone and reviewable by non-technical people on one Storybook screen.
- \+ Reference and compliance material can't break CI: it's outside every tool by
  construction.
- \+ A PDR reads on its own and outlives the working documents it drew on; what it
  rests on outside `docs/` is a dated text in `compliance/`.
- − Another convention to learn (ADR vs PDR vs reference vs compliance); the READMEs,
  the meta test and `product-check` carry that weight.
- − Writing a fact into the PDR instead of linking it takes more words.
- − `reference/` is committed, so large dumps live in git history forever — the
  README calls this out and says to link out instead when a dump is huge. A prototype
  kept as a subtree adds its tree to history at every update, squashed into one
  commit each time.

## Discarded directions

- **`compliance/` under `docs/`.** `docs/` holds what the project writes and goes
  through its tools; these texts are received, often as `.docx`, and stay outside the
  toolchain like `reference/`.

- **A git submodule for a prototype kept as reference.** It is empty in every new clone
  and worktree until fetched, which needs access to the prototype's remote; the
  shortcut of pointing it at a path on disk is refused by git (`protocol.file.allow`),
  and allowing that transport opens it to any submodule a repository declares.
- **A plain copy of the prototype's files.** Fine for one that will not change again,
  but it loses the link to the prototype's repository, so an update is a manual diff.
