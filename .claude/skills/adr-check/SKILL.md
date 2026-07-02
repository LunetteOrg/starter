---
name: adr-check
description: Assess the Lunette starter against its own ADRs in docs/adr/ (the templates system — the CLI, the template model, the scaffolding contract) and report misalignments plus decisions that should be recorded. Report-only — never edits files. Use when asked to check ADR alignment, audit the templates system, or find drift, AND automatically as part of every code review and PR review (see CLAUDE.md).
---

# ADR alignment assessment (Lunette starter)

Produce a **report** comparing this repo against its recorded decisions. Do **not**
edit files, create ADRs, or apply fixes — output findings and recommended actions
only.

**Scope.** These ADRs govern the *templates system* (the CLI, the template model,
the scaffolding contract) — see [ADR-0001](../../../docs/adr/0001-recording-decisions.md).
A single template's *own* application architecture is recorded inside that template
(`packages/create/templates/<framework>/docs/adr/`) and is NOT this skill's concern.

## Procedure

1. **Load the decisions.** Read `docs/adr/README.md` and the `## ` sections of each
   `docs/adr/NNNN-*.md`, plus `CLAUDE.md`. Build the check matrix *now* from what
   you read — never recite from memory; the ADR set evolves.

2. **Scan the system for violations.** Typical checks you'll derive today (read the
   ADRs for the authoritative set):
   - **ADR-0002 (shared base + enforced vs recommended):** does each template carry
     the base (monorepo tooling, mechanically-enforced boundaries, ADR/guidance
     structure, scaffolding contract)? Is a *recommendation* (DDD tactical, GoF,
     Clean Code, FP) being enforced where it shouldn't, or vice versa?
   - **ADR-0003 (bundled folders):** is `pnpm-workspace.yaml` still `packages/*`
     only (templates NOT workspace members)? Does `@lntt/create` ship `files:
     ["bin","templates"]`? Are templates named by their **web framework**? Has a
     **shared package been extracted prematurely** (duplication-now is the rule)?
   - **ADR-0004 (scaffolding contract):** does the CLI's text-file coverage include
     every config type a template actually uses (the `.editorconfig` gap class)?
     Does every template have a `.lunette-template` marker, and does the CLI strip
     it + restore `_`-dotfiles? Are placeholders (`@starter`, creds) consistent?
   - **ADR-0001 (scope split):** is a *system* decision recorded here, and a
     *template-architecture* decision recorded in the template — not swapped?

3. **Prefer the existing tests.** `pnpm --filter @lntt/create test` scaffolds each
   template and asserts invariants; treat a passing assertion as a passing check,
   not a finding. Record each real hit as `path:line` with a one-line explanation.

4. **Find unrecorded decisions.** Flag system-level choices present in the code but
   not covered by any ADR (a new CLI capability, a new template axis in the naming,
   a change to the contract). Propose the ADR to write, following `docs/adr/template.md`.

## Output format

```
# ADR assessment (Lunette starter)

## Violations of existing ADRs
- [severity] ADR-NNNN — <rule>. Evidence: path:line. Recommended action: …

## Unrecorded decisions (ADRs to create)
- <proposed title> — <why>. Suggested status: proposed.

## Passing checks (brief)
- ADR-NNNN — <rule>: holds (enforced by <test / config>).
```

Severities: **blocker** (violates an accepted ADR), **warning** (drift or partial),
**note** (worth recording, not yet wrong). Lead with blockers; end clean if clean.
