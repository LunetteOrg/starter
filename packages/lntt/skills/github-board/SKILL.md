---
name: github-board
description: Open, write, triage, prioritize, organize and link GitHub issues on the project's GitHub Project (v2), as the `board` section of `.agents/config.*` describes it — the issue types and which are parents, the fields and their options, sub-issues, iterations, milestones, blocked-by dependencies, track labels — with every id resolved at runtime. Required before any `gh issue create`, a single follow-up or a bug spotted mid-PR included: an issue with no type and no fields is invisible to every view. Use when asked to open, file, retitle, triage, prioritize, organize or link issues, to set up or fix the board, or to wire dependencies. `plan-round` produces a plan; this skill lands it on the board.
---

# GitHub board

This skill owns the **mechanics** of issues and of the Project: how an issue is written,
typed, placed and linked. `plan-round` (a round of work) and `roadmap` (the long
horizon) decide *what* goes on the board and defer here for *how*. The `gh` and GraphQL
recipes are in [`references/github-project.md`](./references/github-project.md): read
the sections a step names before running it.

The values are the project's: the `board` section of `.agents/config.*`. Why the team
works this way (what *Ready* means, what a milestone stands for, the meaning of a field
of its own) is in `docs/process/board.md`, when the project has one. This skill is the
procedure; it is never edited to fit one project.

## 0. Read the board

```sh
lntt get board              # the whole section; lntt get fails on a key it does not have
lntt get team               # members (owners, assignees) and the language issues are written in
```

**No `board` section:** stop. Say what this skill would need, and propose a section
built from what GitHub shows (the Project with `gh project list`, its fields with
`gh project field-list`, the organization's issue types, the labels): the person decides
and writes it (`lntt set`). Never carry on with guessed values.

Then read `docs/process/board.md` when it exists.

**What the section leaves out, the project does not use**, and the skill does without
it instead of failing or creating it:

| The configuration | When present | When absent |
|---|---|---|
| `board.issueTypes` | set one of its types on every issue; `parents` hold work and never enter an iteration, `children` are the work | set no issue type |
| `board.subIssues: true` | link the work to its parent as a sub-issue | no sub-issues: name the parent in the body |
| `board.milestones: true` | set the milestone (a release, unless the process says otherwise) | no milestone |
| `board.blockedBy: true` | a hard dependency is a blocked-by relation | write it in the body |
| `board.fields.<key>` | set it, on the issues its `on` names (`parents`, `children`, any when absent), with one of its `options` | leave it alone |
| `board.tracks` | a track label and its owner on every issue | no track label |
| `team.members` | assignees are members | assign whom the person names |

A field's GitHub name is its `name`, never its key: the horizon may be called anything
on the Project. A field of the project's own (any other key) is set when
`docs/process/board.md` or the person says when; otherwise leave it.

**Option order carries meaning:** `priority`'s options run most urgent first, `horizon`'s
nearest first. The status roles (`board.fields.status.initial`, `ready`, `inProgress`,
`inReview`, `done`) name the options the skills set; a role left unset is the schema's
default, which `lntt validate` has checked against the options. Statuses the automation
sets (`delivery.candidate.status`) are never set by hand.

**Never add an option to a field, nor create a field, without the person's go**:
changing the options of an existing single select rewrites every item's value
([reference, *Changing a field's options*](./references/github-project.md#changing-a-fields-options)).
A value the board needs and the configuration lacks is a proposal for the configuration,
then for the Project.

## 1. Resolve the ids, once per session

The configuration names things; GitHub wants ids. Resolve them once and keep them in
variables ([reference, *Discovery*](./references/github-project.md#discovery)): the
Project's node id (from `board.project.owner`, `ownerType` and `number`), each
configured field's id and option ids, the current iteration when `fields.iteration` is
set, the issue types' node ids when `issueTypes` is set, the labels.

The Projects API is GraphQL only, and its budget (5000 points an hour) is shared by
every session and agent using the same token. Two commands spend it: a full item list
(~100 points per 100 items) and the field list (~100). Read the fields **once per
session**; for one issue, ask the issue for its item id (1 point), never list the board
([reference, *Cost*](./references/github-project.md#cost)).

## 2. Write an issue

A **title** is read on the board, in a milestone, in a list: without the body. Write it
so the list is enough.

- **Unambiguous:** a problem found, or a change to make. A present-tense statement that
  reads both as how things are and as how they should become is not ("Issue titles are
  unambiguous": are they, or must they be made so?).
- **Ideally actionable and measurable:** an action verb, then the observable result that
  closes it ("Turn Ryuk back on, so a killed run cleans up after itself").

A **body** lets an agent start cold, without redoing the exploration. When the
repository has an issue template (`.github/ISSUE_TEMPLATE/`) use it; otherwise these
parts, headed in `team.language`:

- **Goal:** one or two lines.
- **References:** the concrete pointers: file paths, the routes to open, the data and
  entities involved, the decision records it rests on, the names to use. Mandatory: a
  thin body is the main failure mode.
- **Tasks:** the checklist of the work.
- **Definition of Done:** how the work is checked, the review included; for a UI change,
  a check in the browser against its source, happy and non-happy states.
- **Depends on:** hard and soft dependencies, and what it does *not* depend on when
  someone would assume it.

A body that bets on a number (*changing the button raises the clicks*) says what will be
looked at to know how it went: the measure, *not yet, a first sub-issue produces it*, or
*not measured* with the reason. Silence is not a fourth answer: an event not
instrumented before the release has no *before* to compare with.

## 3. One issue: the fast path

The commonest case is a single issue opened at the end of a pull request. It takes every
step below: an issue with no type and no fields is not triaged, and no view catches it.
A single issue the person asked for needs no confirmation of its content; it still needs
the steps.

1. **Ids**, from section 1.
2. **Create** it with the title and body of section 2, its track label and the track's
   owner as assignee (`board.tracks`), and the milestone when `board.milestones`.
   REST creates it with its type in one call
   ([reference, *REST*](./references/github-project.md#rest-a-separate-budget-and-fewer-steps)).
3. **Type**, when `board.issueTypes`: a child type for work, a parent type only for an
   issue that will hold others.
4. **On the Project**: an organization workflow may already have added it (`item-add`
   then fails as a duplicate: go on). Get its item id from the issue (1 point).
5. **Fields**: the status role `initial` unless the person says otherwise, and every
   configured field whose `on` fits the issue and whose value is known now. A field of
   `kind: issue` is written on the issue, never on the item, or it fails, sometimes
   silently ([reference, *Issue fields*](./references/github-project.md#issue-fields)).
6. **Parent**, when `board.subIssues` and a parent holds it.
7. **Iteration**: only for a child chosen for an iteration now (section 5).
8. **Read it back** from GitHub, aimed at the item (`node(id:…)`, not a list), and show
   it: number, type, fields, parent. The check closes the step; never assume it went
   through.

## 4. Many issues: triage, structure, report

- **Confirm before any batch** of creates or edits: show what will change. Never create
  a Project, a field, an option or a milestone without the person's go.
- **Triage** (one issue or a batch): type, Project, the fields that apply, track label
  and owner, milestone, parent. **Triaged is not scheduled:** a triaged backlog has its
  fields set and `iteration` and `horizon` **empty**. Filling them at triage would put
  the whole backlog in the current iteration, or *Now*.
- **Structure**: parents hold children (`subIssues`); a parent has at most about **8–10
  open children**: past that its grouped view reads as one long list again, and the
  signal is to split it along a real seam (an area, or the nature of the work).
- **Report** (read-only unless asked): group by iteration, milestone, priority or
  horizon; surface the untriaged: no type, no parent, a missing configured field, not on
  the Project. List with an explicit `--limit` sized just above the board: without one
  the list truncates silently, and "nothing to do" may be a truncated read.
- **Writes in bulk** fail silently three ways: about 20 aliased mutations per call (more
  exceed the resource limit), ~1.2 s between mutations (the secondary rate limit does not
  show in `rate_limit`), and a `--silent` that hides each failure. Count the outcomes and
  read the result back ([reference, *Writing in bulk*](./references/github-project.md#writing-in-bulk)).

## 5. Iterations and horizons (when configured)

- **Only children go in an iteration** (`fields.iteration`, `on: children`); a parent is
  never scheduled. The iteration is set when a child is **chosen** for one, never at
  triage. The current iteration is the one whose start ≤ today < start + duration, read
  from the field's configuration, never assumed.
- **The horizon** (`fields.horizon`) says when a parent is taken up; it is set when the
  team decides to work on it, not at triage. The priority (`fields.priority`) says how
  much it matters, with or without a horizon; inside one horizon, it is the order.
- **A missing iteration** (the next one, for a blocked issue) is added in the Project's
  settings, by hand: the API's `updateProjectV2Field` rewrites the whole field.

## 6. Dependencies

Two mechanisms for two meanings:

- **Hard:** the work cannot be built correctly before another lands; starting early is
  rework. With `board.blockedBy`, a native blocked-by relation (reference,
  *Dependencies*); without it, a line in the body's *Depends on*.
- **Soft:** it can start in parallel, a sequence is preferred. A higher priority on the
  prerequisite (when `fields.priority` exists), and a `Soft: #N` line in *Depends on*.
  Never a blocked-by: it pollutes every "unblocked work" filter.
- **A blocker and the issue it blocks, with different assignees, never share an
  iteration:** the blocked issue goes in the iteration after the blocker's, so its
  owner starts from work done, not from work landing the same week. Same assignee, same
  iteration is fine. An exception is written in the blocked issue's body, with its
  reason and the person's agreement.

## 7. Track labels — derive, do not hardcode

`board.tracks.labels` records the known tracks, each with its owner and the `paths` it
covers; `board.tracks.from` names the folders that are candidate tracks.

1. **Read what exists:** `gh label list`, and the configuration. Reuse a label over a
   near-synonym; a scheme named differently on GitHub is surfaced, not overridden.
2. **Candidates:** each folder matching `tracks.from` that no label's `paths` covers, and
   each area the plan groups work into that no track owns. A piece of work that fits no
   track is the signal of a missing track, or of mis-scoped work: resolve it, never
   invent a label to hide it.
3. **Propose** the new labels (name, owner, one-line purpose), confirm, then **create
   only the missing ones** (never `--force`, never rename) and add them to
   `board.tracks.labels` with `lntt set`.

**Before inventing any marker:** a dimension an issue has exactly one value of is a
single-select field; a dimension it can have several values of is a label (Projects v2
has no multi-select field). Prefix a label that carries a dimension (`lever:growth`).

## 8. An issue that is no work

- **An open decision** is a question before it is work. When the status field has an
  option for it (`docs/process/board.md` names it), it sits there and leaves it only
  when the decision is recorded in the repository (a record of `recording.logs`) and
  linked; otherwise it is a child whose deliverable is the written decision. A parent
  whose scope is undecided is not split into children: that would split a scope that
  does not exist yet. A decision that will not mature by waiting (it needs customers, a
  market, data months away) is closed as *not planned*, and the question moves to where
  someone will meet it: the open questions of the record it concerns.
- **A container born from a theme** rather than a piece of work (it holds things with
  different owners, or placeholder children "to detail later") is split and closed. A
  placeholder child is closed **and detached** from its parent: a closed child left
  attached shows the parent as done.

## Guardrails

- Every value from `lntt get board`; every id resolved at runtime; nothing the
  configuration leaves out assumed or created.
- Confirm before any batch, and before creating a Project, field, option, milestone or
  label.
- Parents never in an iteration; iteration and horizon set when scheduling, not at
  triage.
- Hard dependencies blocked-by (when configured), soft ones priority and a cross
  reference.
- One full board read per need, the fields once per session, a targeted query for one
  issue; `--limit` always explicit and sized to the board.
- Count the outcomes of bulk writes and read the result back.
