---
name: roadmap
description: Plan beyond one iteration — split a broad objective into parent issues, date them on the Project's roadmap paced by the velocity measured on closed iterations, and re-forecast when an iteration closes — as the `board` section of `.agents/config.*` describes the board. Use when planning past the next round, turning a big goal into a roadmap, checking whether a plan fits its timeline, or re-forecasting after an iteration closes. `roadmap` creates and dates the parents; `plan-round` breaks the due ones into children.
---

# Roadmap — the long horizon

Two tiers of planning, kept apart:

- **`roadmap`** (this skill): **objective → parents**, dated across iterations by the
  velocity observed. *What are the big pieces, and roughly when.*
- **`plan-round`**: **parents → children** for the round coming up. *Exactly what we
  build now.*

The cycle: objective → `roadmap` → `plan-round` → `github-board` (every write) →
`retrospective` → velocity → `roadmap` again.

## 0. Read the board

`lntt get board` and `lntt get cycle`; `docs/process/board.md` and `docs/process/cycle.md`
when they exist. **No `board` section:** stop, and propose one (`github-board`,
section 0). Then resolve the ids (`github-board`, section 1), the closed iterations
included.

This skill needs more of the board than the others. What it does without each piece:

| Missing | What the roadmap does |
|---|---|
| `board.issueTypes.parents` and `board.subIssues` | no parents to schedule: say so, and offer to plan with `plan-round` alone |
| `board.fields.iteration` | velocity per window of `cycle.iteration.days`, counted on the closing dates of the children; with neither, no velocity: say so, and date nothing |
| `board.fields.startDate`, `targetDate` | the forecast is reported, not written on the Project: propose the fields |
| `board.fields.horizon` | the parents are ordered by priority only |

## 1. Split the objective into parents

Break the goal into **parents** (a parent type of `board.issueTypes.parents`, cohesive,
a few iterations of work at most). Present the split for approval with the trade-offs it
makes; never add scope silently. Then create them through `github-board`: type, track
label, owner, the horizon when this round of planning decides it, **no iteration**.

**Permanent parents stay out** (`board.issueTypes.permanent`, or the field of the
project's own that `docs/process/board.md` names for it): they hold work with no end, so
a date would promise one that never comes. Filter them out whenever reading the parents
for the roadmap.

## 2. Measure velocity — after the fact, never estimated ahead

- For each **closed** iteration, count the children whose status reached
  `board.fields.status.done` while in it ([reference, *Velocity*](../github-board/references/github-project.md#velocity)).
  The children of a permanent parent count: they are work done; only the parent has no
  end.
- When a plain count hides a large spread, weigh each done child by a proxy measured on
  it (merged pull requests, commits, diff size, days from `inProgress` to `done`), never
  a guess. A configured `size` field is a guess made earlier: report it beside the
  measure, never instead of it.
- A **rolling average** over the last few closed iterations; split by track or owner
  when independent tracks run in parallel.
- With one closed iteration or none, say so: the first forecast is a rough prior,
  tightened as iterations close.

## 3. Forecast and date

From the remaining parents and the measured velocity, project how many iterations each
needs and date it (`startDate`, `targetDate`, written as their `kind` says: an issue
field on the issue) so its bar spans the right iterations. **The roadmap and the
iterations agree:** a parent dated for iteration *N* has its children in *N*, through
`plan-round`; reconcile, never let the two drift.

## 4. Re-forecast at each iteration's close

With the `retrospective`: recompute the velocity with the iteration just closed, slide
the dates, and flag early a parent whose remaining work no longer fits its window. The
roadmap is a living forecast, not a Gantt drawn once.

## Handoff to `plan-round`

`roadmap` decides **which** parents come next; `plan-round` takes those whose window
opens now and decides **how** they are built.

## Guardrails

- Velocity is measured, not wished: never pack an iteration past what closed ones
  delivered.
- The split into parents is approved before any is created.
- Parents never in an iteration: they carry dates; children carry the iteration.
- Permanent parents never on the roadmap.
- Every value from the configuration, every id at runtime, every write through
  `github-board`.
