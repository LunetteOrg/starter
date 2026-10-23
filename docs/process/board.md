# Board: how the starter plans its work

The work is planned on a GitHub Project, read and written with the `github-board`
skill; `plan-round` shapes a round of work and lands it there. The values (the
Project, the issue types, the fields and their options) are `board` in
[`.agents/config.jsonc`](../../.agents/config.jsonc). This page holds what is
particular to this repo.

## One board for the organization

The Project `board.github.project` belongs to LunetteOrg, not to this repository: it
holds the issues of the organization's other repositories too (the closed issues of
`lunette`, the archived engine), and its automation adds every new issue of the
starter. The issue types are the organization's: a type added, renamed or removed
changes every repository of LunetteOrg, and an option changed on a field of the
Project changes every item on it. Both go through the person who owns the
organization, as the `github-board` skill says for any field or option.

The organization also has issue fields of its own (a priority, an effort, a start and
a target date). They are not the board's: `board.fields` names only fields of the
Project, and nothing reads the issue fields.

## Each field answers one question

| Question | Where |
|---|---|
| Where is it? | `board.fields.status` |
| When do we take it up? | `board.fields.horizon` |
| How much does it matter? | `board.fields.priority` |
| What kind of work is it? | the issue type, `board.issueTypes` |
| How big is it? | `board.fields.size` |

A value belongs to one question only. "Not now" is a horizon, not a priority: an issue
keeps its priority while it waits. The names of fields and options are in English, so
they read the same on every board built on this model.

## Issue types

The parent types (`board.issueTypes.parents`) say what kind of work an issue is:

- **Feature**: something for the people who use Lunette: the CLI, the shared skills,
  the templates, the plugin, the shared packages.
- **Platform**: what the starter itself runs on: its CI, the release and candidate
  automation, its board.
- **Debt**: a technical debt to pay back.
- **Ongoing**: recurring work with no end (maintenance, support).

A parent holds its work as sub-issues (`board.subIssues`), and its children are the
child types (`board.issueTypes.children`): a **Task** is a piece of its parent's work
and takes the parent's kind; a **Bug** is something that does not work as it should,
under a parent or alone. An issue that stands alone, with no parent and no children,
takes the parent type of its kind of work. Debt and Ongoing never close
(`board.issueTypes.permanent`): they stay off the roadmap, and the children done under
them count.

## Status

An issue moves through `board.fields.status` this way:

- **Todo** when it is opened: the `github-board` skill's fast path, or the Project's
  auto-add.
- **Ready** when it can be picked up: its body lets an agent start cold (the
  `github-board` skill's *Write an issue*), and it has its type and its priority.
- **In progress** when someone, a person or an agent in a worktree, works on it.
- **In review** when its pull request is ready for review.
- **In release** and **Done** are the candidate automation's
  (`delivery.candidate.status`, [delivery](./delivery.md#the-candidate-automation)):
  squashed into the open candidate, then merged into `main`. They are never set by
  hand, except to repair what the automation could not write (its `::notice` says
  when).

The Project's built-in workflows (auto-add, item closed, pull request linked or
merged) set only these options; their values are read and changed in the Project's
settings.

## Horizon and milestones

A milestone is a release (`board.milestones`), one per version, named after it
(`v0.6.4`), its description saying what the release carries. The horizon
(`board.fields.horizon`) is set on parents, when the team decides when to take them
up: **Now** is the release being built, **Next** the releases after it, **Later** what
is wanted with no release yet, **Backlog** what is not planned. A triaged issue has
its type, priority and parent, and no horizon until that decision.

The starter has no iterations: it plans by release, not by time box. Velocity, which
the `roadmap` skill reads from closed iterations, is not measured here.

## Size

`board.fields.size` is set on the issue a worktree works on, parent or child: the
coordinator picks the child's model by it (`coordinator.models.children`). It is set at
triage when the work is understood, and otherwise before the issue is Ready.

## Labels

The labels are GitHub's defaults plus `hotfix` (`delivery.candidate.hotfix`). There
are no track labels (`board.tracks`): one repository, with one owner.

## Views

| View | Layout | Filter | By hand in the Project's UI |
|---|---|---|---|
| Board | board, a column per status | `is:open` | |
| Horizon | table | `is:open type:Feature,Platform,Debt,Ongoing` | group by Horizon |
| Release | table | `is:open` | group by Milestone |
| All | table | none | |

The API creates a view with its name, layout and filter; grouping is set in the UI.

## Discarded directions

- **Removing the Task type.** Every issue type would be a kind of work, and the board
  would have no child type for the work under a parent; Task is also the type of
  closed issues across the organization, which would lose it.
- **A Status with no In release.** The candidate automation sets it on the issues a
  candidate holds, and `lntt validate` rejects a `delivery.candidate.status` that is
  not an option of the Status.
- **A custom field for the kind of work** (pelion's *Classe*). An issue type follows
  the issue onto every Project and into search, and is defined once for the
  organization.
- **Scope or When for the horizon.** A scope reads as a work's perimeter, a when as a
  date; the horizon is a relative band.
- **A Not now priority.** It answers *when*, which is the horizon's question.
