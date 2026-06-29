---
name: adr-check
description: Assess the codebase against the ADRs in docs/adr/ and report misalignments plus architectural decisions that should be recorded as new ADRs. Report-only — never edits files. Use when asked to check ADR alignment, find architectural drift, or audit decisions, AND automatically as part of every code review and PR review (see CLAUDE.md).
---

# ADR alignment assessment

Produce a **report** comparing the code against the recorded architecture
decisions. Do **not** edit files, create ADRs, or apply fixes — output findings
and recommended actions only.

## Procedure

1. **Load the decisions.** Read `docs/adr/README.md` (the index) and the
   `## Decision` section of each `docs/adr/NNNN-*.md`. Also read the
   "Architecture Rules" in `CLAUDE.md` — it is the distilled, enforceable form
   of several ADRs.

2. **Derive a check matrix** from those decisions. The current ADRs imply at
   least these checks (re-derive from the files; don't trust this list blindly):
   - `process.env` only inside `config/env.ts` (ADR-0002).
   - No `new Date()` — `Temporal` instead (ADR-0002).
   - No `throw new Error()` — typed `errore` errors (ADR-0005).
   - Domain imports no framework (`react-router`) and no `lib/` (ADR-0003/0004).
   - Routes use `context.app` only — no use-cases/domain/db/bootstrap imports (ADR-0004).
   - Use-cases compose via injected deps, never import each other (ADR-0013).
   - `tryAsync()` at the repository boundary, `matchError()` at routes (ADR-0005).
   - Test naming: `.spec.ts` = unit, `.test.ts` = integration; no `vi.mock` of the DB (ADR-0006).
   - E2E only for critical flows, clean `storageState` (ADR-0006).
   - Migrations follow expand-migrate-contract (ADR-0007).
   - Design tokens are CSS custom properties in `@starter/ui-tokens` (ADR-0014).
   - Storybook stories co-located in `packages/ui`, Foundations from tokens (ADR-0015).

3. **Scan for violations.** Prefer the existing tooling and helpers over ad-hoc
   greps where they exist (Biome overrides in `biome.json`, per-app
   `app/arch.spec.ts`, `assertLayerBoundaries` / `getImports` in
   `@starter/test-utils`). For rules not mechanically enforced, search the
   sources directly. Record each hit as `path:line` with a one-line explanation.
   Note explicitly when a rule is already guarded by Biome/arch tests and still
   holds — that is a passing check, not a finding.

4. **Find unrecorded decisions.** Flag architecture-level choices present in the
   code but not covered by any ADR — e.g. a new top-level package, a new
   external dependency that shapes the architecture, a new layer or cross-cutting
   pattern, a deviation from an accepted ADR that looks intentional. For each,
   propose the ADR to write (title + one-line rationale), following the
   MADR-lite `docs/adr/template.md`.

5. **Handle the empty case.** The starter ships without apps; many checks will
   have no files to scan. Say so plainly rather than reporting false passes.

## Output format

```
# ADR assessment

## Violations of existing ADRs
- [severity] ADR-NNNN — <rule>. Evidence: path:line. Recommended action: …

## Unrecorded decisions (ADRs to create)
- <proposed title> — <why it needs an ADR>. Suggested status: proposed.

## Passing checks (brief)
- ADR-NNNN — <rule>: enforced by <Biome override / arch test>, holds.
```

Use severities: **blocker** (violates an accepted ADR in shipped code),
**warning** (drift or partial), **note** (worth a decision, not yet wrong).
Keep it scannable; lead with blockers. End with nothing to fix if clean.
