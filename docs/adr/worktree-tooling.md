---
status: accepted
date: 2026-10-16
tags: [worktrees, agents, orca, herdr, branches, setup]
---

# Worktree tooling: the rules in `lntt`, the tools as adapters

## Context

Work on an issue happens in its own worktree, often with an agent in it, and the
worktree is created by whatever tool the person uses: Orca, Herdr, `git worktree add`
in a terminal, an agent harness. Each tool has its own idea of the branch name (Orca
prepends the user and flattens the slashes: `<user>/<name>`), its own setup hook or
none (Herdr has none), and its own way to start an agent with a model (Orca's
`worktree create --agent` takes no model; opencode's interface takes no model flag).
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
  report the friction met. `--prompt` replaces it for a coordinator's own instructions.
- **The agent, its model and its effort** (`--kind`, `--model`, `--effort`) reach each
  tool in the form it accepts:
  - Orca without a model: `worktree create --issue --agent --prompt`, the agent
    starting after the setup (`wait-for-setup`).
  - Orca with a model or an effort: the worktree with its issue, the setup, then
    `orchestration worker-start` on it, in a Run created when none is bound.
  - opencode with a model, on any host: its inline configuration
    (`OPENCODE_CONFIG_CONTENT`) on a standalone server, started as a shell command in a
    terminal or pane of its own, and prompted once the tool sees it ready.
  - Herdr: `herdr agent start --kind` with the model and effort after `--`.
- **What cannot start is refused before anything is created**, never dropped or left
  half done: an agent flag the agent cannot take (one started on another model or
  effort than the one asked for is a different agent), and in a batch any issue that
  cannot be read or named, so several `--issue` start whole or not at all.
- **Worktrees made by `lntt`** (git, Herdr) go under `<main checkout>/.worktrees/`,
  ignored by git with `.claude/worktrees/` of the agent harnesses. Their branch has no
  upstream until it is first pushed: created from `origin/<base>`, it would otherwise
  track the base.
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
- On Orca, an agent started with a model is a supervised worker or a plain terminal,
  not the agent tab `worktree create --agent` opens.
- Orca runs `orca.yaml`'s setup only when the repository's *Command source* is
  "orca.yaml only" or "Run both"; a script once saved in its local field switches it to
  "Local only" without a warning.

### When to deviate (revisit triggers)

- Orca's `worktree create --agent` accepts a model, or opencode a model flag: the
  special paths go.
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
