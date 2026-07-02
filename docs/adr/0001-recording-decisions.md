# ADR-0001: Recording decisions

- Status: accepted
- Date: 2026-07-02

## Context

Architectural decisions need a home that travels with every scaffolded project. A
single large architecture document is hard to consume incrementally (by humans
and AI agents alike) and tends to be rewritten in place, losing decision history.
Decisions need a lightweight, append-only format instead. At the same time, the
starter should hand a new project a *small, coherent* set of decisions to start
from — not a long list of granular records to reconstruct in your head.

## Decision

Record architectural decisions as **numbered ADRs** in `docs/adr/`, MADR-lite
(Status / Date / Context / Decision / Consequences), numbered sequentially
(`0001`, `0002`, …). An ADR may be **thematic**: related decisions are grouped in
one file under `## ` sections (e.g. `0002-architecture-and-boundaries.md` covers
layering, import boundaries, typed errors, use-case composition, and self-arming
enforcement). Reference a specific decision by its file plus heading anchor, e.g.
`docs/adr/0002-architecture-and-boundaries.md#import-boundaries`.

**Immutability, and its scope.** An accepted ADR is immutable in meaning: changing
a decision means writing a new ADR that supersedes the old one. **This applies to
projects built *from* the template, not to building the template itself.** While
the starter is being constructed, ADRs are consolidated and renumbered freely to
keep the starting set small and coherent — history of the template's own drafting
is not the point; a clean foundation is. Once you scaffold a project, its ADRs are
append-only from there.

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
