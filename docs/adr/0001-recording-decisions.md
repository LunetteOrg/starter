---
status: accepted
date: 2026-07-02
tags: [process, adr]
---

# ADR-0001: Recording decisions

## Context

This is the **Lunette starter** — it holds `@lntt/create` and the Lunette
templates. Decisions here are *about the templates system itself* (what a Lunette
template is, how templates are organized, the scaffolding contract), not about any
one template's application architecture. Those template-level decisions live
inside each template (e.g. `packages/create/templates/react-router/docs/adr/`).
The two decision logs must not be confused.

## Decision

Record decisions about the templates system as **numbered ADRs** in this repo's
`docs/adr/`, in **MADR** format ([`template.md`](./template.md)): YAML
frontmatter (`status`, `date`, `deciders`, `tags` — machine-readable, so ADRs
can be searched and filtered by tag) and the sections Context / Decision /
Alternatives considered / Consequences (Positive · Negative / accepted risks ·
When to deviate). Numbered sequentially; ADRs may be thematic. ADRs written
before this format carry the frontmatter but keep their original compact body —
alternatives and revisit triggers are recorded going forward, not backfilled.

- **Scope**: this log governs the *system* — the CLI, the template model, the
  shared contract. A template's *own* architecture (layering, ORM, framework) is
  recorded in that template's `docs/adr/`, which travels with scaffolded projects.
- Reference a decision by file + heading anchor.
- ADRs here are append-only once accepted; supersede rather than rewrite.

## Consequences

- \+ The templates system has a decision history separate from any template's, so
  changing the CLI or the model doesn't muddy a template's architecture record.
- \+ New contributors learn "what a Lunette template is" from a small set of ADRs.
- − Two ADR logs exist (this repo + each template). The scope split above keeps
  them apart; reviews must file a decision in the right one.
