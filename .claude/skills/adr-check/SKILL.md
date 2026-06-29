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

2. **Derive the check matrix at runtime — do not hardcode it.** The ADR set
   evolves (decisions get added, renumbered, superseded), so build the matrix
   *now* from what you just read: for each accepted ADR, turn its `## Decision`
   into one or more checkable rules, and pull the enforceable rules listed under
   "Architecture Rules" in `CLAUDE.md`. Skip ADRs marked `deprecated` /
   `superseded`, and follow the supersede link to the replacement. Tie every rule
   back to the ADR it came from by reading the file, never by reciting a number
   from memory. (Typical rules you'll derive today concern `process.env`
   confinement, `Temporal` vs `Date`, typed `errore` errors, domain/use-case/route
   import boundaries, the repository/route error handling seam, test-file naming
   and no-mock-the-DB, migration strategy, and design-token/Storybook conventions
   — but read the ADRs to get the current, authoritative set.)

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
