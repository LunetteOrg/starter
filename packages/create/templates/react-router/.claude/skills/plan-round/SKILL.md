---
name: plan-round
description: Repeatable planning process for a work round / iteration. Explore the problem (input-agnostic — works greenfield or from reference material like a prototype, legacy system, or spec), surface the real decision forks to the user, triage the existing backlog, shape the work into a Feature→sub-issue tree, and materialize it on the standard GitHub Project board. Use when asked to plan a round/iteration/milestone, turn a prototype/spec/legacy system into issues, or organize upcoming work into features and tasks.
---

# Planning a round

Turn a fuzzy goal ("build the associate dashboard", "ship the landing site",
"start the app") into an approved, assigned, scheduled set of issues on the
GitHub Project — the same way every time, whatever the inputs.

This skill owns the **process**. The **board structure and all issue/Project
mechanics** (native types, sub-issues, iterations, milestones, priority, dependencies)
belong to the **`github-board`** skill — its
[board reference](../github-board/references/github-project.md) is the source of truth
for structure and `gh`/GraphQL recipes. Read
it before the Materialize phase. Division of labour: `plan-round` produces the tree and
the decisions; `github-board` lands it on the board.

**Two planning tiers.** For an objective spanning many iterations, the **`roadmap`**
skill runs first: it decomposes the broad objective into **Features** and schedules them
across iterations by measured velocity. `plan-round` then takes the Features whose window
opens now and breaks each into sub-issues. When the objective is only ~one iteration, this
skill creates the Features itself (the degenerate case) — but still set each Feature's
Roadmap dates (Start/Target) so it lands in the right window, and defer the multi-iteration
horizon to `roadmap`.

## Principles

- **Input-agnostic.** The process is identical whether there is a rich prototype +
  legacy DB (a remake) or nothing but a sentence (greenfield). Only the Explore
  phase changes shape. Never assume `reference/` exists.
- **Discover, never hardcode.** Resolve repo, owner, Project number, field ids,
  iteration ids, issue-type node ids, labels and collaborators **fresh at runtime**
  (see the reference). IDs in this file would rot.
- **The user owns the forks.** Where a choice genuinely changes the plan (UI stack,
  auth mechanism, persistence, scope), present options and let the user pick — do
  not decide silently. Record the chosen decisions in the issue bodies (and an ADR
  when architectural).
- **Decisions live in the repo**, not in chat or a private note (see `CLAUDE.md`).

## Process

### 0. Orient (discover the board)
Resolve the environment before planning anything: repo/owner, the Project and its
fields, the **current iteration** (the one whose `startDate ≤ today < end`), the
native issue types, labels, and collaborators. Commands in the reference. Confirm
you're targeting the right Project if several exist.

### 1. Explore (shape depends on inputs)
Build an accurate picture with **read-only** fan-out agents (the `Explore` agent
type), run in parallel:
- **If reference material exists** (prototype, legacy code, design/product docs,
  DB dumps): one agent per source — map the UI surfaces to build, the domain/data
  model, and any existing auth. If a prototype is running, drive it in a browser
  (Claude-in-Chrome) to capture real screens **and non-happy states** (empty,
  loading, error, status variants) — these become explicit work later.
- **If greenfield**: gather requirements from the user, then explore only the
  current repo (apps, packages, ADRs) to learn the conventions the new work must
  follow.
- **Always** explore the target repo's current state (what exists vs. what the plan
  assumes) and the relevant ADRs/guidances.

Synthesize into a dense findings summary — not a file dump.

### 2. Decide (surface the forks)
From the findings, name the choices that actually branch the plan and ask the user
(`AskUserQuestion`), with a recommended option and honest trade-offs. Typical forks:
UI toolkit/stack, auth/session approach, persistence (DB now vs. mock), and how much
scope this round covers. Weave the answers into the plan and the issue bodies.

### 3. Triage the existing backlog (do not skip)
**Always** review open issues before creating new ones. List the backlog buckets —
issues with **no iteration** and/or **no parent** — and for each decide, with the
user for anything they'd want a say in:
- **fold into this round** (attach as a sub-issue under a Feature and schedule it),
- **leave in backlog** (out of scope this round), or
- **close** as obsolete.
New work and existing backlog are planned together, not in isolation.

### 4. Shape (Feature → sub-issue tree)
Structure the round into the board's shape (see reference):
- **Features** = the macro units (one per cohesive area/epic).
- **Sub-issues** = the shippable tasks under each Feature (branches of 1–2 days).
- **Tracks**: group Features so independent people can work in parallel (usually by
  app/area); assign an owner per track. State the dependency waves and call out any
  imbalance honestly. Hand the track set to `github-board` to decide which labels to
  create (derived from the repo + this plan, confirmed before creating — see its
  *Track labels* section); never assume a fixed label list.
- **Dependency hygiene (reduce rework).** For each task mark **hard** deps (cannot be
  built correctly until the other lands — starting early = rework) vs **soft** deps
  (can start in parallel, only final integration needs the other). Then name the
  **shared contracts to freeze first** — the interfaces many tasks bind to, where
  churn causes the most rework: DTO/read-view shapes, enums and identifiers, design-
  token names, and the session/context shape. Freezing these before dependents start
  is the cheapest way to avoid rework. Wire **hard** deps as native GitHub blocked-by
  relationships; express **soft** deps / urgency through **Priority** (bump the
  prerequisite) plus a labelled cross-reference (see `github-board`'s *Dependencies*).
- **Reuse existing issues** where they fit rather than duplicating.
- **No separate "review" or "ADR" Feature.** Review is part of every task's DoD, and
  a decision an issue makes is recorded as an ADR *in that same issue's PR* — checking
  ADRs after the fact is not a work item.

Present the tree for approval **before** writing to GitHub. If reusing an issue
means **renaming** it, list the `old title → new title` changes explicitly and get
an ok first — a silent rename is disorienting.

#### Task & Feature anatomy — self-sufficient bodies
Every issue body must let an agent start cold, without re-doing the exploration.
Use this shape:
- **Obiettivo** — one or two lines.
- **Riferimenti** — the concrete pointers gathered in Explore: prototype/source file
  paths **and** the live routes to open (e.g. `http://localhost:PORT/…`), spec/legacy
  file paths, the exact data fields/entities, the relevant ADR numbers, and the
  token/API names to use. This section is mandatory — thin bodies are the main
  failure mode.
- **Task** — the checklist of work.
- **Definition of Done** — includes the in-task review (`adr-check` / `story-check` /
  `product-check` / `design-check` + `arch.spec`) and any ADR to write. **For any UI /
  graphical task, add a Claude-in-Chrome visual review against the source** (open the
  prototype route, compare happy *and* non-happy states) — always push graphics
  through a browser check inside the task.
- **Dipende da** — explicit, including **cross-track (non-)dependencies** (state what a
  task does *not* depend on when it's a likely assumption, e.g. an Astro site does not
  depend on a React component library — only on the shared tokens).

### 5. Materialize (write to the board)
Only after approval, follow the **`github-board`** skill and its
[reference](../github-board/references/github-project.md): create/edit issues with full
bodies (Obiettivo / Task / Definition of Done), set the **native issue type** (Feature vs
Task/Bug — via GraphQL node id, not the REST id), link sub-issues to their Feature, wire
**hard deps** as blocked-by, assign owners, apply the track label, set **Priority (P0–P3)**
per the dependency waves, and add **only the sub-issues** to the current iteration —
**Features never go in an iteration**.

### 6. Verify & report
Re-read the result from GitHub: hierarchy (each Feature's children), issue types,
iteration membership (Features excluded, sub-issues present), assignees. Report the
tree with issue links, the track split, and the suggested starting order.

## Guardrails

- Confirm before the mass create/edit (the tree is approved in phase 4); per-issue
  edits the user explicitly requested need no extra ask.
- **Explicit renames** — never silently retitle an existing issue.
- **Features never in an iteration** — only sub-issues carry Iteration / Priority /
  Size (the prioritized-backlog view filters `-type:Feature`).
- Resolve all ids fresh; the `updateIssue.issueTypeId` mutation needs the **GraphQL
  node id** of the type (`IT_…`), not the REST numeric id — a known trap.
- Keep exploration agents **read-only**; they map, they don't edit.
- **Review and ADRs live inside the task that owns them** — never a trailing review/ADR
  Feature. UI tasks carry a Claude-in-Chrome check in their DoD.
- **Never ship a thin body.** If the Riferimenti section is empty, the task isn't ready
  to hand to an agent.
- **Capture friction for the retrospective.** When you fan out sub-agents (here or in
  later implementation), require each to return any friction / automation-opportunity it
  hit; the orchestrator folds these into commit `Retro:` trailers and the PR retrospective
  (see the `retrospective` skill) so signals survive many agents and a different PR author.
