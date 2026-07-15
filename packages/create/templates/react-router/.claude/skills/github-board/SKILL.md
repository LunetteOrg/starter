---
name: github-board
description: Manage GitHub issues and the GitHub Project (v2) board — the standardized structure, native Feature/Task/Bug types, sub-issues, iterations, milestones, priority (P0–P3), size, and dependencies (hard blocked-by + soft-via-priority). Discovers repo/owner/project and all ids at runtime (never hardcoded). Use when asked to create, triage, prioritize, organize, or link issues; set up or fix the board; manage iterations/milestones/priorities; or wire dependencies between issues. The `plan-round` skill produces the plan; this skill owns how it lands on the board.
---

# GitHub issues & Project board

This skill owns the **mechanics and structure** of issues + the Project board. The
`plan-round` skill owns the *planning process* and defers here for how work lands.
Detailed `gh`/GraphQL recipes live in
[`references/github-project.md`](./references/github-project.md) — read it before mutating.

This skill mutates GitHub. **Show the plan and confirm before any batch create/edit**;
a single explicit edit the user asked for needs no extra ask. Never create an
org/user-level Project or field without explicit confirmation.

## The board standard (stable conventions — resolve ids fresh)

- **One org-level Project (v2)** holds all planning (discover its name and number at
  runtime, never assume).
- **Native issue types** drive hierarchy: **`Feature`** (macro/epic) is the parent;
  **`Task`**/**`Bug`** are its **native sub-issues**. Type — not a label — marks the level.
- **Iterations** (~2-week windows) are the primary cadence. **Only sub-issues go in an
  iteration** — a **Feature is never scheduled** (the prioritized-backlog view filters
  `-type:Feature`). Iteration / Priority / Size live on sub-issues.
- **Labels = tracks/areas**, one **assignee = owner** per track — **derived from the
  repo and the plan, not hardcoded** (see [Track labels](#track-labels--decide-dont-hardcode)).
- **Fields**: `Status` (Backlog / Ready / In progress / In review / Done), `Priority`
  (**P0–P3**, see below), `Size` (XS–XL), `Iteration`, `Milestone` (= release), Start/Target date.

## Track labels — decide, don't hardcode

Track labels are **derived and confirmed, never assumed**. Deciding the set is its own
step (run it at bootstrap and whenever the plan introduces work no existing track owns):

1. **Read what exists** — `gh label list` (recipe in the reference). Reuse an existing
   label over a new near-synonym; if the repo already runs a differently-named scheme,
   surface it and ask before diverging.
2. **Derive candidates** from two sources, then intersect:
   - **Repo structure** — one track per top-level app (`ls apps/`), plus the
     cross-cutting areas that own work no single app does (e.g. `infrastructure` for
     CI/deploy/tooling, `design-system` for `packages/ui`, `docs`).
   - **The plan** — the tracks `plan-round` / `roadmap` grouped the Features into
     (usually by app/area). A Feature that fits **no** candidate is the signal to add a
     track — or that the Feature is mis-scoped; resolve it, don't invent a label to hide it.
3. **Propose the set** — a short list of `kebab-case` names, each with its **owner**
   (assignee) and a one-line scope, flagging which are new vs already present. Confirm
   before creating anything.
4. **Create only the missing ones** — `gh label create` (recipe in the reference); never
   recreate or rename an existing label. Keep it minimal: a track earns a label when
   independent work runs in parallel under a distinct owner, not before.

## Dependencies between issues

Structure dependencies **on the issues**, two mechanisms for two meanings:

- **Hard** (cannot be built correctly until another lands) → native GitHub
  **blocked-by** relationship (`addBlockedBy`); the board shows "blocked by / blocking"
  and filters unblocked work.
- **Soft / urgency** (can start in parallel; sequence preferred) → **Priority**. Give
  the prerequisite (or the urgent item) a higher `P`, so it's picked first *without*
  marking anything blocked. Also drop a labelled `**Soft:** #NN` cross-reference in the
  body's *Dipende da* section for the paper trail.

Marking non-blocking work as a hard blocker pollutes "unblocked work" filters — keep the
distinction.

## Priority P0–P3

Single-select field, four options — **urgency + the soft-dependency lever above**:
`P0` critical / unblocks-the-most · `P1` high · `P2` normal · `P3` low. Bootstrap the
options once (`updateProjectV2Field`, recipe in the reference) if the field is empty.
Rule of thumb when the plan has dependency waves: roots that unblock everything → P0,
next wave → P1, and so on; then bump anything genuinely urgent.

## Workflows

- **Discovery / bootstrap** — resolve owner/repo, the Project, its fields + option ids,
  the current iteration, native issue-type node ids, labels, collaborators. Create
  milestones / a Project / the Priority options only on confirmation.
- **Triage** (per issue or batch) — set Milestone (release), add to the Project, set
  Priority / Size / Status, apply the track label, assign the owner. For sub-issues also
  set the Iteration; **never** set an Iteration on a Feature.
- **Structure** — set the native issue **type**, link **sub-issues** to their Feature,
  wire **hard deps** as blocked-by. (The `plan-round` skill drives this end-to-end.)
- **Organize / report** — group by iteration / milestone / priority; surface untriaged
  issues (no type, no parent, no priority, not on the board). Read-only unless asked.

All the exact commands (including the issue-type **node-id** gotcha, sub-issue linking,
blocked-by, iteration set, and Priority-option bootstrap) are in the reference.

## Guardrails

- Confirm before batch create/edit, milestones, Projects, or field changes; resolve all
  ids fresh (never hardcode a project/field/option/type id).
- `updateIssue.issueTypeId` needs the type's **GraphQL node id** (`IT_…`), not the REST
  numeric id.
- **Features never in an iteration**; only sub-issues carry Iteration / Priority / Size.
- Hard deps → native blocked-by; soft deps → priority + cross-reference (never a hard block).
- Respect an existing differently-named field/scheme — surface it and ask before diverging.
