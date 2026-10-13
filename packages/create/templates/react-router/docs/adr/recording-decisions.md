---
status: accepted
date: 2026-10-13
tags: [process, adr, pdr, guidances]
---

# Recording decisions

## Context

Decisions need a home that travels with the project and that a person, or an agent,
can read in one sitting. A single large architecture document is hard to consume
piece by piece; a long list of granular records leaves every reader to reconstruct
the current state from a chain of amendments.

## Decision

The project keeps two decision logs, plus recommendations:

- **Architecture decisions** in `docs/adr/`.
- **Product and design decisions** (PDRs) in `docs/product/decisions/`, each with its
  review page in Storybook's `Product/` section
  ([product & reference spaces](./product-and-reference-spaces.md)).
- **Guidances** in `docs/guidances/`: patterns the template does **not** ship (auth,
  feature flags, secrets, background jobs, graceful shutdown), recommendations for
  the app you build. A guidance becomes a decision when the project adopts it.

Both logs follow the same rules:

- **One file per subject, named after it** (`architecture-and-boundaries.md`). The
  file name is the id; there are no numbers and no dates in the name. A file groups
  the related decisions of its subject under `## ` sections.
- **Corrected in place.** A file states what holds now. When a decision changes, its
  file is rewritten and the change lands as a commit; the history of a subject is
  `git log --follow -- <file>`. No `superseded by`, no struck-through text, no
  amendment sections.
- **Options not taken** close the file in *Discarded directions*, each with the
  reason it does not hold.
- **MADR format** ([`template.md`](./template.md); the PDR log has its own): YAML
  frontmatter (`status`, `date`, `tags`, optional `deciders`; tags make the log
  searchable) and Context / Decision / Consequences / Discarded directions.
- **Cited by file and heading anchor**, in prose and in code comments:
  `docs/adr/architecture-and-boundaries.md#import-boundaries`.
- **A new file only for a new subject.** A decision about a subject that has a file is
  written into that file.

## Consequences

### Positive

- A new project starts from a small set of thematic ADRs it can read, or load into an
  agent's context, in one sitting.
- Every file reads as the current state; nobody reconciles a decision with its
  amendments.
- No contended counter between concurrent pull requests.
- Guidances never pass for shipped decisions.

### Negative / accepted risks

- Recording a decision is a discipline nothing enforces; review must ask "does this
  change need an ADR, a PDR, or a guidance?".
- The history of a decision is in git, not in the file.

### When to deviate (revisit triggers)

- The project adopts the installable `decisions` skill: the generic rules move there,
  and this file keeps only what is particular to the project.

## Discarded directions

- **Numbered, append-only records that supersede rather than rewrite.** A decision
  spreads over an original and its amendments that every reader has to reconcile, and
  the number is contended between concurrent pull requests, silently (two different
  file names never conflict in git).
- **A numbered seed plus one dated, immutable file per new decision.** Collision-free
  and chronological, but a subject's current state is spread over many files.
- **One architecture document.** Hard to read or load piece by piece.
