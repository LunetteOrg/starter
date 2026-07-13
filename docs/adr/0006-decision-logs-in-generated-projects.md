---
status: accepted
date: 2026-07-13
deciders: []
tags: [process, adr, pdr, scaffolding, templates]
---

# ADR-0006: Decision logs in generated projects — thematic seed, atomic dated evolution

## Context

Every Lunette template ships two decision logs that travel into the scaffolded
project: architecture decisions (`docs/adr/`) and product/design decisions
(`docs/product/decisions/`). Both identified records with an incremental
zero-padded counter (`NNNN-short-kebab-title.md`, "take the next free number").

Generated projects are trunk-based with many short-lived, concurrent PRs (the
templates say so themselves). The counter turns every new record into a contended
resource: two open PRs both read "the next free number" as `0008` and both use it.
Crucially the collision is **silent** — the two PRs create *different* filenames
(`0008-a.md`, `0008-b.md`), so git sees no path conflict, merges both cleanly, and
the duplicate number lands in the trunk with nobody warned. It bites hardest on
the PDR log (one file per decision, frequent) and on any new thematic ADR file.

Two forces pull against each other here. A decision log should preserve history
and **supersede** rather than rewrite — which favours a per-decision, immutable
ledger. But the ADR set is also meant to hand a new project a *small, coherent
foundation* it can read in one sitting — which favours few thematic files. The
counter served neither: it was a contended id, not a history spine, and this
system already renumbers its own ADRs freely while drafting.

## Decision

Templates identify decision-log records by **date, not a shared counter**, and
separate a curated **seed** from ongoing **atomic evolution**.

- **ADRs — thematic seed + atomic dated evolution.** The template ships a small
  set of thematic ADRs (`0001-000N`) — the architectural foundation, immutable
  once scaffolded. A *new* architectural decision in a derived project is its own
  **atomic, dated, immutable** file `docs/adr/YYYY-MM-DD-short-kebab-title.md`
  (one decision per file, MADR format) — never appended as a section into a seed
  file. A new ADR may supersede a seed section by pointing at its heading anchor
  and marking that section superseded (kept visible, not deleted).
- **PDRs — pure atomic dated log.** Product/design decisions carry no seed:
  `docs/product/decisions/YYYY-MM-DD-short-kebab-title.md`, one file per call.
- **Supersession keys on the record's id** (`superseded by 2026-07-13-…`), which
  is stable and never renumbered; the date carries chronology. The seed's numeric
  ids (`ADR-0002`) stay the compact citation handle used across `CLAUDE.md`, code
  comments, and arch tests.

The only remaining collision is the desirable one: two records created the same
day with the **same slug** land on the *same filename*, so git conflicts loudly —
and that conflict means "the same decision was recorded twice", which is exactly
what you want surfaced.

**Scope.** This governs what templates ship *to generated projects*, where
concurrent PRs are the norm. This system repo keeps sequential numbering for its
own `docs/adr/` (few contributors, low PR concurrency) and may revisit.

## Alternatives considered

### A — Keep the counter, resolve collisions at merge

Tolerate duplicate numbers and renumber the loser during merge. Rejected: the
collision is *silent* (different filenames never conflict), so it relies on a
reviewer noticing — or a bespoke lint the template must ship and maintain. And
"renumber the loser" mutates a supposedly-stable id after the fact, chasing every
inbound `superseded by` and code citation that already pointed at it.

### B — One atomic dated log for everything, drop the thematic ADR seed

Maximally faithful to the classic per-decision ledger. Rejected: it throws away
the "read the foundation in one sitting" onboarding value that is the seed's whole
purpose, and forces churn on every `ADR-000N` citation in `CLAUDE.md`, comments,
and arch tests.

### C — Opaque unique ids (ULID / random suffix)

Collision-free by construction. Rejected: unordered and unreadable; a date gives
the same collision-freedom *and* chronology for free.

## Consequences

### Positive

- No contended counter: concurrent PRs never silently collide on an id.
- Architectural evolution gets an atomic, immutable ledger with clean
  supersession — the history the ADR mechanism is supposed to preserve.
- The seed stays small and readable; the evolution grows without touching it.
- Record ids are stable forever — never renumbered.

### Negative / accepted risks

- Two id schemes coexist (numbered seed, dated evolution). This is a deliberate
  signal — *numbered = shipped foundation, dated = your project's log* — not
  disorder.
- You lose the "decision #N" count. Cosmetic; the date orders the log.
- Chronology is **day-granular**: several records dated the same day sort
  lexically by slug, not by the hour they were written. Acceptable — the id is
  the date, and finer ordering has never mattered for a decision log.
- Same-day, same-slug records still need a manual merge resolution — but a loud,
  trivial one.

### When to deviate (revisit triggers)

- A template whose projects are single-writer with no concurrent PRs can keep a
  plain counter.
- If a seed file itself starts churning heavily in derived projects, reconsider
  whether that area should move to the atomic dated log too.
