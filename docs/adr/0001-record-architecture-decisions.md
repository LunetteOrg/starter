# ADR-0001: Record architecture decisions as ADRs

- Status: accepted
- Date: 2026-06-11

## Context

Architectural decisions used to live in a single BMAD planning artifact (`_bmad-output/planning-artifacts/architecture.md`, ~1700 lines). It was tied to the BMAD methodology, hard to consume incrementally (by humans and AI agents alike), and rewritten in place — losing decision history. The starter is moving away from BMAD; decisions need a lightweight, append-only home that travels with every scaffolded project.

## Decision

Record each architectural decision as one file in `docs/adr/`, using a MADR-lite format (Status / Date / Context / Decision / Consequences). Numbering is sequential (`0001`, `0002`, …). An accepted ADR is immutable in meaning: changing a decision means writing a new ADR that supersedes the old one.

The BMAD infrastructure (`_bmad/`, `_bmad-output/`, `.claude/skills/bmad-*`) is removed. The original architecture document remains available in git history; its decisions are migrated to ADR-0002 through ADR-0012.

## Consequences

- \+ Decision history is preserved; each decision is small enough to read (or load into an AI context) on its own.
- \+ `CLAUDE.md` and `CONTRIBUTING.md` can point to specific ADRs instead of a monolith.
- − Writing an ADR is a manual discipline; nothing enforces it. Code review must ask "does this change need an ADR?".
