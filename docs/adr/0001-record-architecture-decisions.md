# ADR-0001: Record architecture decisions as ADRs

- Status: accepted
- Date: 2026-06-11

## Context

Architectural decisions need a home that travels with every scaffolded project. A single large architecture document is hard to consume incrementally (by humans and AI agents alike) and tends to be rewritten in place, losing decision history. Decisions need a lightweight, append-only format instead.

## Decision

Record each architectural decision as one file in `docs/adr/`, using a MADR-lite format (Status / Date / Context / Decision / Consequences). Numbering is sequential (`0001`, `0002`, …). An accepted ADR is immutable in meaning: changing a decision means writing a new ADR that supersedes the old one.

## Consequences

- \+ Decision history is preserved; each decision is small enough to read (or load into an AI context) on its own.
- \+ `CLAUDE.md` and `CONTRIBUTING.md` can point to specific ADRs instead of a monolith.
- − Writing an ADR is a manual discipline; nothing enforces it. Code review must ask "does this change need an ADR?".
