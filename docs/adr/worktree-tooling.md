---
status: accepted
date: 2026-11-04
tags: [worktrees, agents, orca, herdr, branches, setup, base-branch]
---

# Worktree tooling: the rules in `lntt`, the tools as adapters

## Context

Work on an issue happens in its own worktree, often with an agent in it, and the
worktree is created by whatever tool the person uses: Orca, Herdr, `git worktree add`
in a terminal, an agent harness. Each tool has its own idea of the branch name (Orca
prepends the user and flattens the slashes: `<user>/<name>`), its own setup hook or
none (Herdr has none), and its own way to start an agent with a model (Orca's
`worktree create --agent` took no model in 1.4.224, 1.4.229 takes one; opencode's
interface takes no model flag).
Left to the tools, the branch convention, the setup and the instructions handed to the
agent would differ by tool and by machine, since the tools keep these settings per
machine.

## Decision

The rules live in `lntt` ([the `lntt` command](./lntt-command.md)); each tool gets a
small adapter that makes the calls it understands.

- **Branch names** are computed, checked and fixed by `lntt branch`: `name` from an
  issue, `check` before push (lefthook) and on the pull request (CI), `rename` in a new
  worktree's setup. The convention and its values are the process's
  ([delivery](../process/delivery.md#branch-names), `delivery.branches`).
- **The host is detected from the environment, innermost first**: Herdr
  (`HERDR_ENV=1`, also when it runs inside an Orca terminal), then Orca
  (`TERM_PROGRAM=Orca` or `ORCA_WORKTREE_ID`), else plain git. Wave and Claude desktop
  create no worktrees: plain git. `--host` overrides it.
- **One setup**, the one the new worktree's own `orca.yaml` declares (the revision it
  checks out, not the main checkout's working copy). Orca runs it through its hook; `lntt`
  runs it itself where the host has none (Herdr, git) and wherever it must know when the
  setup has ended, because Orca's setup terminal stays open as a shell.
- **One brief**, `packages/lntt/agents/brief.md`: the issue is the mandate, work only in
  this worktree, review and `ci:local` green, a draft pull request, then stop, and
  report the friction met; every wait goes through the mailbox, as
  [coordinator mode](./coordinator-mode.md#the-mailbox) states it
  (`packages/lntt/agents/waiting.md`). The brief always comes first: `--prompt` adds
  instructions of one's own after it, in a closing `## Added at start` section, for a
  coordinator and a child alike. A theme's coordinator and its children are
  [coordinator mode](./coordinator-mode.md): the same entry point, other briefs, a model
  per role.
- **Each start leaves a marker** in the mailbox,
  `<git common dir>/lntt-messages/started/<branch, URL-encoded>.json`: the branch, its issue
  (none for a coordinator), and who it reports to (`coordinator` with the theme for a
  child of a theme that has a coordinator, `orchestrator` otherwise, a child of a theme
  with no coordinator included), written before the host starts and dropped when a coordinator's start fails (an
  earlier start's marker stays); a marker that cannot be written is a warning, not a
  failed start, and deleted by `lntt inbox --wait` and `--follow` once its worktree is gone
  and it is older than a minute (the live children of a mailbox,
  [coordinator mode](./coordinator-mode.md)). At `lntt review: limit:` the round
  reads it (a branch still on the name Orca gave it reads the marker of its conventional
  name) and sends the open findings there with the mailbox, without waiting for the
  answer, and prints the id to wait on (`lntt ask --wait <id>`). A branch with no marker, or
  whose mailbox cannot be found or read, stops at the limit with what is open on stdout and
  stderr only.
- **The agent, its model and its effort** (`--kind`, `--model`, `--effort`) reach each
  tool in the form it accepts:
  - Orca: one `worktree create --issue --agent --prompt`, with `--model` and
    `--effort` when the agent has them, the agent starting after the setup
    (`wait-for-setup`); Orca refuses a model and effort the agent does not take, before
    creating anything, and `lntt` reports its reason. The agent's handle is
    `launch.outcome.handle` in the reply.
    The agent starts in a terminal: `lntt` passes `--surface terminal` when
    `worktree create --help` lists `--surface`; an Orca that does not list it gets no
    flag. Without the flag Orca follows the operator's personal Chat | CLI setting, and a
    chat session has no terminal. A coordinator follows its children with `orca terminal`
    (read, wait, send), so the surface is the project's choice, not the operator's. The
    supervised worker below launches its agent in a terminal by construction
    (`worker-start` has no surface option).
  - An Orca whose `worktree create` takes no model (its help lists no `--model`; 1.4.224
    did not, 1.4.229 does): the worktree
    with its issue, the setup, then `orchestration worker-start` on it, in a Run
    created when none is bound.
  - opencode with a model, on any host: its inline configuration
    (`OPENCODE_CONFIG_CONTENT`) on a standalone server, started as a shell command in a
    terminal or pane of its own, and prompted once the tool sees it ready (Orca's
    `terminal wait --for tui-idle`, up to two minutes; Herdr's agent list, looked at once a
    second for a minute); one not ready by then gets no brief, and the start fails.
  - Herdr: `herdr agent start --kind` with the model and effort after `--`.
- **One base, found one way** (`packages/lntt/src/base/base.ts`) by `lntt worktree start` on
  every host, `lntt review` and `lntt ci local`; an explicit `--base` wins in each
  (`origin/<base>`, else the branch of that name, which a stacked child's sibling may
  have only locally). Without `--base` the base is the open candidate when there is one,
  else the default branch (`delivery.candidate.base`, else the branch `origin/HEAD`
  names, else `main`), and always the remote's copy (#224):
  - a new worktree starts from `origin/<candidate>` while a candidate is open, else from
    `origin/<default branch>`; a hotfix (`delivery.candidate.hotfix`: the branch prefix or
    the issue's label) starts from `origin/<default branch>`, where its pull request stays;
  - an existing branch that descends from the open candidate (its fork point with the
    candidate holds commits `origin/<default branch>` lacks) is compared with the
    candidate from that fork point, a branch just started on it included; the candidate
    itself (the branch of its name, or a detached HEAD at its head) goes into the
    default branch; any other branch is compared with `origin/<default branch>`.

  Which candidate is open is asked to GitHub (`gh pr list`, the query of the candidate
  automation): a merged candidate's branch stays on origin and its commits reach the
  default branch rebased, so the refs cannot tell an open one. When GitHub cannot
  answer, the base is `origin/<default branch>` and the command says so. A resolved base
  whose `origin/` ref is not in the clone is an error that asks for `git fetch origin`;
  nothing is fetched. An explicit `--base` with neither `origin/<base>` nor a local
  branch of that name goes to the host as given in `lntt worktree start`, which says
  what it cannot find, is an error in `lntt review`, and leaves `ci:local` with no diff
  to choose its tests from.
  A detached HEAD at a candidate's head is that candidate: `lntt branch check` and
  `ci:local`'s branch name are the `delivery.candidate.prefix` branch whose `origin/`
  ref points at HEAD, so a candidate is checked without a local branch named after it.
- **What cannot start is refused before anything is created**, never dropped or left
  half done: an agent flag the agent cannot take (one started on another model or
  effort than the one asked for is a different agent), and in a batch any issue that
  cannot be read or named, so several `--issue` start whole or not at all.
- **Worktrees made by `lntt`** (git, Herdr) go under `<main checkout>/.worktrees/`,
  ignored by git with `.claude/worktrees/` of the agent harnesses. Their branch has no
  upstream until it is first pushed: created from the base's `origin/` ref, it would
  otherwise track the base.
- **`rename` never fails a setup.** A name it cannot fix, or one the issue cannot give
  (a title with nothing to slug), is reported and the branch stays; the pre-push check
  (on the branches being pushed) and CI stop it if it stays wrong.

## Consequences

### Positive

- A branch, a setup and a brief are the same whichever tool created the worktree, and a
  wrong name stops before it reaches the remote.
- Adding a tool is an adapter; adding an agent is a line in `agentArgs` or
  `shellLaunch`.
- A person or a coordinator starts a batch of agents with one command, without spending
  agent turns on the steps.

### Negative / accepted risks

- The adapters follow the tools' command lines, which change: Orca's worker needs a Run,
  Herdr's create reply does not always carry the new pane, opencode reads its inline
  configuration only on a standalone server. A tool update can break an adapter; the
  tests pin the calls, and a trial run against the real tool confirms them.
- On an Orca whose `worktree create` takes no model, an agent started with a model is a
  supervised worker; opencode with a model is a plain terminal on any Orca. Neither is
  the agent `worktree create --agent --prompt` starts, with the prompt as its first turn.
- An Orca whose `worktree create` lists no `--surface` starts the agent by the operator's
  Chat | CLI setting: with Chat, a coordinator cannot reach it with `orca terminal`.
- Orca runs `orca.yaml`'s setup only when the repository's *Command source* is
  "orca.yaml only" or "Run both"; a script once saved in its local field switches it to
  "Local only" without a warning.

### When to deviate (revisit triggers)

- Every Orca in use takes `--model` on `worktree create`: the worker path goes. opencode
  gains a model flag: its standalone-server path goes.
- A tool offers a setting for the branch name kept in the repository: the rename in
  setup can go for that tool.

## Discarded directions

- **A setting in each tool.** Orca has none in `orca.yaml` for the branch name or its
  prefix, Herdr has none at all, and a setting kept per machine drifts between them.
- **Leaving the rename to whoever opens the pull request.** One more manual step at the
  moment it is easiest to forget, and a wrongly named branch stays on the remote.
- **Waiting for Orca's setup terminal to exit** before starting an agent on a model. It
  never exits: it stays open as a shell.
- **Typing the brief into an agent as soon as its terminal opens.** Text typed into an
  interface that is still starting is lost; the brief goes once the tool reports the
  agent ready, or not at all.
- **Ignoring a model or an effort the agent cannot take.** The run would look right and
  be on another model.
- **The local branch as the base.** A local `main` or candidate branch is as old as the
  last pull: a worktree started from it, or a review and a `ci:local` diffed against
  it, read commits that are already merged.
- **The base from the refs alone, without asking GitHub.** `origin/HEAD` names the
  default branch, not the open candidate, and the candidate branches left on origin
  after their merge look the same as the open one.
- **A base per command** (`delivery.candidate.base` for the worktree and the review,
  `origin/HEAD` for `ci:local`). A branch started on the candidate would be reviewed and
  checked against the default branch, with the candidate's commits in its diff.
- **`--prompt` in place of the brief.** Every use wanted to add context to it; a
  coordinator started that way had none of its issues and approvals.
- **The review round waiting for the answer at the limit.** The round holds the review
  lock, and `lntt review allow`, the answer most often given, needs it free; the wait is
  the agent's, with `lntt ask --wait <id>`.
