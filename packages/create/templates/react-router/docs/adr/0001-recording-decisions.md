---
status: accepted
date: 2026-07-02
tags: [process, adr, guidances]
---

# ADR-0001: Recording decisions

## Context

Architectural decisions need a home that travels with every scaffolded project. A
single large architecture document is hard to consume incrementally (by humans
and AI agents alike) and tends to be rewritten in place, losing decision history.
Decisions need a lightweight, append-only format instead. At the same time, the
starter should hand a new project a *small, coherent* set of decisions to start
from — not a long list of granular records to reconstruct in your head.

## Decision

Record architectural decisions in `docs/adr/`, in **MADR** format
([`template.md`](./template.md)): YAML frontmatter (`status`, `date`, `deciders`,
`tags` — machine-readable, so ADRs can be searched and filtered by tag) and the
sections Context / Decision / Alternatives considered / Consequences (Positive ·
Negative / accepted risks · When to deviate). The log has two parts:

- **The seed** — the thematic ADRs shipped with the template, numbered
  `0001-000N`. Each groups related decisions for one area under `## ` sections
  (e.g. `0002-architecture-and-boundaries.md` covers layering, import boundaries,
  typed errors, use-case composition, and self-arming enforcement). This is the
  small, coherent foundation a new project reads in one sitting; its numeric ids
  are the compact citation handle used across `CLAUDE.md`, code comments, and
  arch tests. Reference a specific decision by file plus heading anchor, e.g.
  `docs/adr/0002-architecture-and-boundaries.md#import-boundaries`.
- **The evolution** — every *new* architectural decision you make in a derived
  project is its **own atomic, dated file**, one decision per file, named
  `YYYY-MM-DD-short-kebab-title.md` (today's date). It is **not** appended as a
  section into a seed file. Dated ids never contend for "the next number", so two
  concurrent PRs can't silently pick the same id (different filenames never
  conflict in git, so a duplicate counter would land unnoticed); the date carries
  chronology. Two records with the same slug on the same day *do* collide on the
  same filename — a loud, correct "same decision recorded twice" conflict.

ADRs written before this format carry the frontmatter but keep their original
compact body — alternatives and revisit triggers are recorded going forward, not
backfilled.

**Immutability, and its scope.** An accepted ADR is immutable in meaning: changing
a decision means writing a **new dated ADR** that supersedes the old one, never
rewriting it in place. This holds down to the section level: to change one
decision inside a thematic seed file, mark that `## ` section
`superseded by YYYY-MM-DD-…`, **leave it in place**, and record the replacement as
a new atomic dated ADR — the history accumulates (live decisions + superseded ones
marked), it is never overwritten.

**This applies from the moment you scaffold.** While a template is being drafted
inside the Lunette starter its ADRs are consolidated and renumbered freely — the
history of the template's own drafting is not the point, a clean foundation is.
That work happens in the starter monorepo, which says so in its own `CLAUDE.md`.
In *this* project the seed is fixed: append-only from here.

**Guidances vs ADRs.** Patterns the template does **not** ship — auth, feature
flags, secrets, background jobs, graceful shutdown — are recommendations for the
app *you* build, not decisions the template has made. They live in
`docs/guidances/` (each marked "not shipped"), separate from `docs/adr/`. Turn a
guidance into a real ADR in your project once you actually adopt it.

## Consequences

- \+ A new project starts from a small set of thematic ADRs it can read (or load
  into an AI context) in one sitting, plus clearly-labelled guidances it can adopt
  on demand.
- \+ `CLAUDE.md`, `CONTRIBUTING.md`, and code comments point to specific ADR
  sections instead of a monolith.
- \+ Guidances never masquerade as shipped decisions, so nobody mistakes a
  suggestion for something the scaffold already provides.
- − Recording a decision is a manual discipline; nothing enforces it. Code review
  must ask "does this change need an ADR — or a new guidance?".
