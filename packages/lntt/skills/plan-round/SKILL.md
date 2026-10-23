---
name: plan-round
description: Plan a round of work, the same way whatever the input — a sentence, reference material (a prototype, a legacy system, a spec) or the transcript of a client meeting. Explore the problem, name the decisions the work rests on and open an issue for each one nobody can close now, surface the real forks to the person, triage the existing backlog, shape the work into parents and children, and land it on the board through `github-board`, as the `board` section of `.agents/config.*` describes it. Use when asked to plan a round, an iteration or a milestone, to turn a prototype or a spec into issues, to organize upcoming work, or to run the intake of a client meeting.
---

# Plan a round

Turn a fuzzy goal ("build the members' dashboard", "ship the landing site") into an
approved, assigned, scheduled set of issues, the same way every time.

This skill owns the **process**. How an issue is written, typed, placed and linked is
**`github-board`**'s: load it (`lntt guide github-board`) before phase 6, and follow it
for every write. For an objective spanning many iterations, **`roadmap`** runs first: it
splits the objective into parents and dates them; this skill takes the parents whose
window opens now and breaks them into children. For an objective of about one round,
this skill creates the parents itself, and still dates them when the board has the
roadmap dates (`board.fields.startDate`, `targetDate`).

The values are the project's (`lntt get board`, `lntt get cycle`); `docs/process/board.md`
and `docs/process/cycle.md`, when they exist, say how the team plans. **No `board`
section:** stop, say what the plan needs from it, and propose the section
(`github-board`, section 0). What the section leaves out, the plan does without: no
issue types, no sub-issues, no iterations, no milestones means the plan is shaped and
written with the mechanisms the project has.

## Principles

- **Input-agnostic.** The process is the same for a rich prototype or a single
  sentence; only phase 1 changes shape.
- **The person owns the forks.** Where a choice changes the plan, present it with the
  criteria that decide it and a recommendation; never decide silently.
- **Decisions live in the repository**, in the logs of `recording.logs` (the
  `decisions` skill), not in chat or in a private note.

## 0. Orient

Resolve the board (`github-board`, sections 0 and 1): the Project, its fields, the
current iteration when `fields.iteration` is set, the issue types, labels, members.

**Ask what the round is about, and take the focus given.** A list of parents or issues
is the scope: plan those, and say what is left out rather than widening the round.
Without a focus, the candidates are the parents whose horizon is the nearest option of
`fields.horizon`, or whose roadmap window opens now: propose them and let the person cut.
**Name the iteration** the round lands in, when the board has iterations: the current
one and the next are different commitments.

## 1. Explore

Build an accurate picture with **read-only** agents, in parallel, each told to report
what it found and any friction it met:

- **Reference material** (a prototype, legacy code, design or product documents, data
  dumps, the paths of `spaces` in the configuration): one agent per source, mapping the
  surfaces to build, the domain and its data, any existing auth. A running prototype is
  driven in a browser to capture real screens **and the non-happy states** (empty,
  loading, error): they become explicit work.
- **Greenfield:** gather the requirements from the person, then explore the repository
  for the conventions the new work must follow.
- **A client meeting:** read it as reference material, then follow
  [*Intake*](#intake--a-client-meeting).
- **Always** the repository as it is (what exists against what the plan assumes) and
  the decision records the work touches.

Synthesize the findings densely: a summary, not a file dump.

## 2. Name the decisions the work rests on

A child written on a decision nobody has taken is an estimate on a guess. For each parent
in scope, ask what it **presupposes**: what its records say is not yet settled, and the
open issues that name those records. Each open decision gets one of three answers:

- **Settled and written down:** the record exists and says it; the child cites it.
- **Ours to settle now:** a fork the person can close in this session: phase 3.
- **Not ours, or not now:** it needs the client, a spike, or someone not here. **Write
  the issue:** the question, who can answer it, and every record the answer changes; it
  is a child of the parent whose work it blocks. The record that makes the assumption
  states the position taken meanwhile and what would make it fall. An assumption living
  only as prose, with no issue and no owner, is never revisited: give it an issue, or
  drop it.

Then say which work in scope **depends** on an open question, and give the person the
choice: plan it on a stated assumption, or leave it out of the round. Writing a record
itself is the `decisions` skill's.

## 3. Decide

Name the choices that branch the plan (a stack, an auth approach, persistence now or
mocked, how much the round covers) and ask, with the criteria and a recommendation.
Weave the answers into the plan and the bodies.

## 4. Triage the backlog

**Always** read the open issues before creating new ones: those with no parent, no
iteration, or a configured field unset. For each, with the person where they would want
a say: **fold it into this round** (under a parent, scheduled), **leave it** in the
backlog, or **close it** as obsolete. New work and the backlog are planned together.

## 5. Shape

- **Parents** (`board.issueTypes.parents`, or issues holding sub-issues): the cohesive
  areas. **Children** (`children`): the shippable work, a branch of one or two days
  each. Without issue types or sub-issues, the tree is still written: the parent named
  in each child's body.
- **Each field where the configuration puts it** (`on`). The horizon goes only on the
  parents this round takes up; a parent triaged but not chosen keeps none. When one
  horizon holds several parents, the priority orders them when its `on` lets parents
  carry it; otherwise the person orders them in the plan. A field of the project's own
  is set as `docs/process/board.md` says.
- **A permanent parent** (`board.issueTypes.permanent`) holds work that never ends:
  its children are planned like any other, the parent itself never closes.
- **An undecided scope is not split.** A parent waiting on a decision gets one child,
  the work that produces the decision; the split follows the record.
- **A bet becomes two children.** For each parent ask *what will we look at to know how
  it went*. When the answer is a number expected to move: the **instrumentation**, only
  if the event does not exist yet (checked now: after the release there is no *before*),
  and the **analysis**, blocked by the first, in the iteration when it is looked at.
  *Not measured* is a legitimate answer, written in the body; silence is not.
- **Tracks:** group the parents so independent people work in parallel, one owner per
  track; state the dependency waves and any imbalance. Hand the track set to
  `github-board` (section 7): labels are derived and confirmed, never assumed.
- **Dependency hygiene.** For each child mark the **hard** dependencies (built before it,
  or it is rework) and the **soft** ones (only the final integration needs the other).
  Name the **shared contracts to freeze first**, the interfaces many children bind to:
  data shapes, enums and identifiers, design token names, the session's shape. Wire
  them as `github-board` section 6 says.
- **Reuse existing issues** where they fit. **No separate review or decision-record
  parent:** the review is in every child's Definition of Done, and a decision a child
  takes is recorded in that child's pull request.
- **Readability:** a parent past the threshold in `github-board` (section 4) is split.

**Present the tree for approval before writing anything.** Reusing an issue under a new
title lists each `old title → new title`: a silent rename disorients.

Every body follows `github-board` section 2: a child an agent cannot start cold from is
not ready. What *Ready* means beyond that is in `docs/process/board.md`, when the project
defines it (the option `board.fields.status.ready`).

## 6. Materialize

After the approval, through `github-board`: create or edit the issues with full bodies,
set the types, link the children, wire the hard dependencies, assign the owners, apply
the track labels, set each configured field on the issues its `on` names (the priority
by the dependency waves, the most urgent option to the roots that unblock the most), and
put **only the children** chosen for the round in the iteration. A blocked child whose
assignee differs from its blocker's goes in the iteration after the blocker's
(`github-board`, section 6).

## 7. Verify and report

Read the result back from GitHub: each parent's children, the types, the iteration
membership (no parent in it), the assignees, the fields. Report the tree with links, the
track split and the suggested starting order.

## Intake — a client meeting

A transcript runs through the same phases. Two things change: what comes out (decision
records, spikes and open questions rather than development work) and how the raw
material is handled.

- **Read it yourself.** Fetch it from where it lives (a document store, a notes tool):
  a connector that needs a sign-in hands back a URL for the person to open; ask, do not
  stall. If nothing works, ask the person to paste the relevant part. Never guess the
  content of a link you could not open.
- **The transcript stays out of the repository:** a link, never a committed file. The
  substance goes into the issue bodies, so a child stands without opening the link. A
  record touched by several meetings keeps a list of their links that **grows**, each
  with what that meeting changed.
- **Three buckets.** Every point lands in one, presented before anything is written:

  | Bucket | What it is | Where it goes |
  |---|---|---|
  | **Confirmed** | the client stated it, and it constrains the build | a record, the principle the work starts from |
  | **Suspended** | it depends on something nobody knows yet | a spike: a record that lists options, no decision |
  | **Open** | it needs the client to answer | an issue with its interlocutor, a child of the parent whose work it blocks, naming every record it touches |

  A point that fits no bucket is a question for the person, not a bucket to invent.
- **A record is corrected in place** when the answers arrive; a new one is written only
  for a new subject (the `decisions` skill). The work that depends on an open question
  is blocked by its issue.
- **Decide each time how many parents** the meeting's output needs, so their grouped
  view stays readable (`github-board`, section 4), split by area or by the nature of the
  work; propose the split, do not settle it alone.

## Guardrails

- Every value from the configuration, every id at runtime (`github-board`); nothing the
  `board` section leaves out assumed or created.
- Confirm the tree before the batch; renames listed explicitly.
- Parents never in an iteration; the horizon only on the parents the round takes up.
- Exploration agents are read-only, and each returns its friction for the
  retrospective (the `retrospective` skill).
- Review and decision records live inside the child that owns them.
- Never a thin body.
