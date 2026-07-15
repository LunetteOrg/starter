---
name: roadmap
description: Long-term, velocity-driven planning across iterations. Decompose a broad objective into Features (epics), schedule them on the Project Roadmap paced by velocity measured retroactively from closed iterations, and re-forecast each iteration. Use when planning beyond a single iteration, turning a big goal into an epic roadmap, checking whether the plan fits the timeline, or re-forecasting after an iteration closes. `roadmap` creates the Features; `plan-round` breaks the due ones into sub-issues.
---

# Roadmap — the long horizon

Two tiers of planning, kept separate:

- **`roadmap`** (this skill) — **objective → Features**, scheduled across iterations by
  observed velocity. Answers "what are the big pieces and roughly when."
- **`plan-round`** — **Features → sub-issues** for the iteration coming up. Answers
  "exactly what do we build now."

Pipeline: **objective → `roadmap` (Features + timeline) → `plan-round` (sub-issues) →
`github-board` (mechanics) → `retrospective` (feedback) → velocity → `roadmap` re-forecast.**
Board mechanics (creating Feature issues, dates, iterations) belong to `github-board`.

## Process

### 0. Orient
Discover the board via `github-board` (Project, iterations incl. `completedIterations`,
issue types, labels, the `Start date` / `Target date` fields the Roadmap view lays out).

### 1. Decompose the objective into Features
Break the broad goal into **Features** (cohesive epics, each a few iterations of work at
most). Surface the proposed breakdown for approval — same discipline as `plan-round`'s
Decide: name the real trade-offs, don't invent scope silently. Then create the Feature
issues through `github-board` (native `Feature` type, track label, owner; **no iteration**
— Features live on the Roadmap, not in a sprint).

### 2. Measure velocity — retroactively, not by pre-estimating
No upfront Size estimates. Read what **actually** completed:
- For each **closed** iteration, count the sub-issues (and Features) that reached
  `Status = Done` while assigned to it. That raw throughput is the base velocity.
- Optionally weight each done item by an **effort proxy derived from the closed issue** —
  merged-PR count, commits, diff size, or time `In progress → Done` — when a plain count
  hides big variance. The proxy is measured, never guessed.
- Keep a **rolling average** over the last N closed iterations; split **per track/owner**
  if independent tracks run in parallel (their velocities differ).
- With only one or zero closed iterations, say so — the first forecast is a rough prior,
  tightened as real data lands. Introduce the `Size` field only if you later need finer
  granularity than retroactive measurement gives.

### 3. Forecast & schedule
Given the remaining Features and the measured velocity, project how many iterations to
completion and place each Feature on the timeline: set its **Start date / Target date** so
the Roadmap bar lands in the right iteration span (a Feature closing inside iteration *N*
gets dates within that window). Keep **roadmap ↔ iterations consistent**: a Feature
scheduled for iteration *N* has its sub-issues in iteration *N* (via `plan-round` /
`github-board`) — the two views must not disagree.

### 4. Re-forecast every iteration close
Hook into the iteration boundary (and `retrospective`): recompute velocity with the new
closed iteration, slide Feature dates, and flag slippage early (a Feature whose remaining
work no longer fits its target window). The roadmap is a living forecast, not a one-time
Gantt.

## Handoff to `plan-round`
For the upcoming iteration, `plan-round` takes the Features whose window opens now and
builds their sub-issue trees. `roadmap` decides *which* Features are next; `plan-round`
decides *how* they're built.

## Guardrails
- **Velocity is measured, not wished.** Schedule to what closed iterations actually
  delivered; don't pack an iteration beyond its demonstrated throughput.
- Surface the Feature breakdown for approval before creating epics.
- Features never go in an iteration; they carry roadmap dates. Sub-issues carry the iteration.
- Keep the roadmap and the iteration assignments in sync — reconcile, don't let them drift.
