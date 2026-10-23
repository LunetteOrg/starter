---
status: accepted
date: 2026-10-17
tags: [agents, coordinator, worktrees, messaging, models]
---

# Coordinator mode

## Context

Several issues of one area go at once: a theme. Each issue gets its own worktree and agent
([worktree tooling](./worktree-tooling.md)), and someone must hold the theme: the order of
the merges, the files two pull requests both touch, the brief of the next issue from what
the previous one learned. A person doing that for every theme at once cannot keep up, and
one agent switching branches fills its context with every diff.

A coordinator needs three things the single-issue flow does not give it: a way to start a
child with the theme's context, a way to ask and be answered that works on every host, and
a say in who may start a child and on which model. Orca, Herdr and plain git share no
messaging command, and Orca's lineage (`--parent-worktree`) has no counterpart in the other
two.

## Decision

### Roles

- **Orchestrator:** the person, or the session above the coordinators. It approves children
  and answers the coordinators' questions.
- **Coordinator:** one per theme, in a worktree of its own on a placeholder branch
  (`chore/no-issue/<theme>`) that is never committed or pushed. It writes no code and runs
  no workflow; its context holds briefs, summaries and the merge order, never diffs. It
  starts one child per issue, or per separable part of one. When the theme ends it
  leaves the theme's own friction in a comment on the candidate pull request (the
  `retrospective` skill).
- **Child:** one per issue, in its own worktree and branch, started from `main` or, when it
  depends on a sibling, from the sibling's branch (`--base`). It follows the single-issue
  brief ([worktree tooling](./worktree-tooling.md)) and stops at a draft pull request.

The coordinator's instructions are the shared `coordinate` skill (`lntt guide coordinate`); the
flags and files are in the `@lntt/lntt` README. The briefs are templates in
`packages/lntt/agents/`: `coordinator.md` for the parent, `brief.md` for a child, with
`reporting.md` and `workflow.md` added to it when the child belongs to a theme.

### The entry point

A `<slug>` is lower-case letters and digits in groups joined by single hyphens; a theme is one.

`lntt worktree start` starts both, with a real switch for each choice:

- `--coordinator --theme <slug> --issue <n>...` starts the theme's coordinator: one
  worktree on no issue, the coordinator's brief listing the issues, `--approve <n>` naming
  the children it may start at once.
- `--theme <slug>` marks a child as the theme's. With it, `--parent <worktree>` is the
  coordinator's worktree as the host selects it (Orca draws the lineage from it; Herdr and
  git have none and the child reaches its coordinator through the mailbox),
  `--context <file>` is the child's section of the theme, rendered into its brief,
  `--size XS|S|M|L|XL` picks its model, and `--workflow` adds the brief section that asks for
  a multi-agent workflow.
- The multi-agent workflow of the harness is switched by `--workflow`, which `lntt` turns
  into the harness's opt-in keyword when it renders the child's brief. The coordinator's
  brief names the flag and never the keyword, so the coordinator is not opted in through the
  child's template.
- Every brief that calls Orca calls it by absolute path, resolved when the brief is rendered.

A child's multi-agent workflow works in three phases (understand with parallel readers,
implement with **one** writing agent in the child's worktree, verify with the review checks
and an adversarial pass), has at most 6 agents, and never uses `isolation: 'worktree'`: it
would nest git worktrees inside one the host does not track.

### The gate

`coordinator.gate` in `.agents/config.jsonc` is `propose` (default) or `free`. Under
`propose`, `lntt worktree start --theme` sends one message to the orchestrator for the
children not yet approved and creates nothing until the answer is `approve`, `approved`,
`yes` or `ok`, with at most a final `.` or `!`. Approvals are kept per theme in the shared mailbox directory
(`approved-<theme>.txt`), written by `--approve` at the coordinator's start and by an
approving answer; the person may edit the file, one issue number per line. No flag of `lntt` approves a child for the coordinator.

### The model per role

`coordinator.models` names the agent (`kind`, `model`, `effort`) of the coordinator and of
the children by the issue's Size. `--size` picks the child's entry; `--kind`, `--model` and
`--effort` on the command line win, field by field. A role without an entry runs on the
agent's own default. Which Size an issue has is the coordinator's judgement (the
`coordinate` skill says how). Reviews keep `delivery.review`.

### The mailbox

`lntt ask`, `lntt inbox` and `lntt answer` carry the questions between the roles, on any
host, with no messaging command of Orca or Herdr:

```
<git common dir>/lntt-messages/to-<role>/<YYYYMMDD-HHMMSS>-<topic>.md           the question
<git common dir>/lntt-messages/to-<role>/<YYYYMMDD-HHMMSS>-<topic>.answer.md    the answer
```

- `<topic>` is `--topic`, else the first line of the question slugged and cut to 40 characters, else `message`.
- `<role>` is `orchestrator`, `coordinator` or `child`. Several coordinators and children
  share one repository, so a coordinator is addressed by its theme
  (`to-coordinator-<theme>`, `--theme`) and a child by its issue (`to-child-<issue>`,
  `--issue`). Without it, the role's own directory.
- `ask` writes the question and polls for the answer file every 20 seconds
  (`LNTT_POLL_SECONDS` changes it); stdout is the answer. `inbox` lists the unanswered
  messages of a role as JSON lines, and with `--wait` blocks until there is one. `answer`
  writes the answer file; the first answer stays.
- The directory is shared by every worktree of the repository and belongs to none of them:
  nothing in it is committed.
- Both directions work: a child asks its coordinator and reports to it; a coordinator asks
  the orchestrator, and the orchestrator can ask either.

The commands read and answer files written by hand with the same names, and a
`to-coordinator` directory is the unqualified coordinator's. `LNTT_ROLE`, `LNTT_THEME` and
`LNTT_ISSUE` default `inbox`'s role and address (the issue for a child, the theme for a
coordinator); `--interval` sets one call's poll.

### The scaffolding contract

Nothing here changes it. `coordinator` is an optional section of the configuration schema
that `@lntt/lntt` ships; no placeholder, dotfile, provenance field or rewrite of
`@lntt/create` is touched, and a template's configuration works with or without it.

## Consequences

### Positive

- A theme is held by one clean context, and a child needs nothing but its brief and the
  mailbox.
- The gate and the models are settings of the project, enforced by the command that starts a
  child, not sentences each brief must repeat.
- The mailbox is plain files: it works across Orca, Herdr, git and any agent that has a
  shell, and a person can read or answer it with an editor.

### Negative / accepted risks

- Polling at the default interval means an answer takes up to 20 seconds to be seen, and a blocked
  `ask` holds its terminal.
- The gate stops a coordinator that follows `lntt`. A coordinator that calls `orca` or `git`
  directly, or writes into the mailbox directory (an answer to its own proposal, the approved
  file), bypasses it. The brief tells it not to.
- Two approvals of one theme written at the same moment can drop one: the file is renamed
  into place whole but not locked.
- Herdr and git show no lineage; the theme's structure there is the mailbox and the briefs.
- The opt-in keyword lives in `workflow.md`, one file a coordinator has no reason to read.

### When to deviate (revisit triggers)

- A host offers a messaging command every host shares: `ask` moves onto it and the files
  stay as the fallback.
- Approvals of one theme are written at the same moment and one is lost: the file moves to a
  lock.
- The harness's multi-agent mode gets a setting of its own: `--workflow` sets it and the
  keyword goes.

## Discarded directions

- **A prompt-only gate** ("ask before starting a child" in each brief): a brief can forget
  it, and the sibling coordinators would each word it differently.
- **Orca's messaging for the coordinator-child questions:** ties the mode to one host.
- **Splitting the opt-in keyword in two halves in the coordinator's brief:** depends on a
  string not appearing; the flag is the switch.
- **One `to-coordinator` directory for every theme:** several coordinators would read each
  other's questions.
- **The coordinator approving its own children with a flag:** the gate would be a sentence
  again.
