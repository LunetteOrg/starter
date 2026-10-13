---
status: accepted
date: 2026-10-13
tags: [process, adr]
---

# Recording decisions

## Context

This is the **Lunette starter**: it holds `@lntt/create` and the Lunette
templates. Its decisions are *about the templates system itself* (what a Lunette
template is, how templates are organized, the scaffolding contract), not about any
one template's application architecture. Those template-level decisions live
inside each template (e.g. `packages/create/templates/react-router/docs/adr/`).
The two decision logs must not be confused.

## Decision

Decisions about the templates system are ADRs in this repo's `docs/adr/`:

- **One file per subject, named after it** (`scaffolding-contract.md`). The file
  name is the id; there are no numbers.
- **Corrected in place.** A file states what holds now. When a decision changes,
  its file is rewritten; the history lives in git. No `superseded by`, no
  struck-through text, no amendment sections.
- **MADR format** ([`template.md`](./template.md)): YAML frontmatter (`status`,
  `date`, `tags`, optional `deciders`; tags make ADRs searchable) and the sections
  Context / Decision / Consequences (Positive · Negative / accepted risks · When to
  deviate) / Discarded directions. Options that were rejected are collected in
  *Discarded directions* at the end, each with the reason it does not hold, so a
  reader does not propose them again.
- **Cited by file and heading anchor**
  (`scaffolding-contract.md#placeholders`).
- **Scope**: this log governs the *system*: the CLI, the template model, the
  shared contract. A template's own architecture (layering, ORM, framework) is
  recorded in that template's `docs/adr/`, which travels with scaffolded projects
  and follows its own rules
  ([decision logs in generated projects](./decision-logs-in-generated-projects.md)).

## Consequences

### Positive

- The templates system has a decision record separate from any template's, so
  changing the CLI or the model does not muddy a template's architecture record.
- Each file reads as the current state, in one sitting; no reader reconstructs a
  decision from a chain of amendments.
- No contended counter between concurrent PRs.

### Negative / accepted risks

- Two ADR logs exist (this repo + each template). The scope split keeps them
  apart; reviews must file a decision in the right one.
- The history of a decision is in `git log -- docs/adr/<file>`, not in the file.

### When to deviate (revisit triggers)

- The generic recording rules move into an installable decisions skill and the
  project's own values into `.agents/config.*` (#36, #37): this file then shrinks
  to what is specific to this repo.

## Discarded directions

- **Numbered, append-only ADRs that supersede rather than rewrite.** A decision
  then lives across several files and amendments that a reader has to reconcile,
  and the number is a contended resource between concurrent PRs. Both projects
  scaffolded from the template correct their ADRs in place.
