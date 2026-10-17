---
status: accepted
date: 2026-10-17
tags: [cli, packages, agents, ci, commands]
---

# The `lntt` command

## Context

The people and the agents of a Lunette project run the same small set of tools every
day: read a configuration value, find out who they are talking to, keep the managed
block of `AGENTS.md` in step, run the CI on the machine, move a pull request onto the
candidate, name a branch, start an agent on an issue. Each tool needs the project's
configuration, and every project uses all of them. Split across packages, each one
would add a command name to learn and an install to keep at the right version, for no
saving: none of them is useful without the others.

## Decision

One package, `@lntt/lntt`, with one command, `lntt`. The package is named after its
command, so a reader who sees `lntt` in a script knows which package provides it.

```
lntt path | validate | get | set | operator | sync | local app | viewer
lntt check [agents-md | decisions [structure | numbers]] | check cite
lntt branch name | check | rename
lntt review [reply]
lntt worktree start
lntt ci local | candidate
```

- **One entry point, one module per command group.** `bin/lntt.ts` dispatches to
  `src/cli.ts` (configuration, operator, `AGENTS.md`, local apps, viewer),
  `src/check-cli.ts`, `src/branch-cli.ts`, `src/review-cli.ts`, `src/worktree-cli.ts`
  and `src/ci/cli.ts`. A group loads only when it runs.
- **What a person types is what an agent runs.** Skills, workflows, git hooks and
  `orca.yaml` call `lntt`, never a package's files by path, with one exception: the
  candidate workflow runs `node packages/lntt/bin/lntt.ts`, because it installs only
  this package and its dependencies.
- **Output for scripts.** stdout carries only the result: a bare value (`lntt path`,
  `lntt branch name`), JSON (`lntt get`, `lntt operator`), or one JSON line per item
  (`lntt worktree start`, followed by the brief when no agent was started, for the
  person who will start one; `lntt check --json`), or a report for a person (`lntt
  check` without `--json`); progress and child-process output go to stderr. Exit codes:
  0 ok, 1 a configuration error, a red result or a check that cannot run (one line on
  stderr), 2 a usage error; a defect of `lntt` itself keeps its stack trace.
- **`lntt check` is the one verb for what is checked without judgement**, in areas:
  `decisions`, whose results its review lens reads, and `agents-md`, which no lens
  needs; a lens's checks are the area named after it. Alone it runs every area, which is
  what CI runs. Every check reports `PASS`, `FAIL` or `NOT RUN` with its reason, so a
  check that did not run is never read as one that passed, and `INFO` for what it prints
  without a verdict; `--json` gives one line per result (`area`, `check`, `status`,
  `path`, `line`, `message`), `--base <ref>` limits a check to what the diff touches
  where that makes sense. What a project ships to others (a shared package, a skill)
  cites the records of the project that installs it: `recording.externalReferences`
  names those files with the reason, and a glob that matches nothing fails. A new
  deterministic check is a check of an area, or a new area, never a script beside a
  skill.
- **No aliases for old names.** A command is renamed in the same pull request as every
  caller, and the plugin's version moves with its skills.

## Consequences

### Positive

- One install and one version for everything a project's tooling needs, in step with
  the other `@lntt/*` packages ([publishing](./cli-runtime-and-publishing.md)).
- A new capability (worktrees, a future one) is a subcommand, not a package to create,
  publish and add to every template.

### Negative / accepted risks

- A project that only reads its configuration still installs the CI's dependencies
  (`@actions/expressions`, `@actions/workflow-parser`): accepted, since every
  Lunette project runs `ci:local` too.
- `@lntt/lntt` repeats the scope in the name; it is seen in `package.json` and
  `npx @lntt/lntt`, never in daily use.

### When to deviate (revisit triggers)

- A group of commands is wanted by projects that are not Lunette projects (the CI
  runner alone, for example): it becomes a package of its own, with its own command.
- The command is rewritten in a compiled language: one binary keeps the same command
  surface.

## Discarded directions

- **A package per concern** (`@lntt/project-config` with `lntt-config`, `@lntt/ci` with
  `lntt-ci`). Two names to learn and two versions to keep for tools that are always
  installed together; the CI one already depended on the configuration one.
- **A package name different from its command** (`@lntt/agent-kit` running `lntt`).
  The reader cannot tell from a script which package to install.
- **`lntt` as an unscoped package.** It leaves the `@lntt` scope, which says who
  publishes it, and needs a trusted publisher of its own.
- **A dispatcher that runs `lntt-<group>` binaries from other packages**, as git does
  with its subcommands. A second mechanism to maintain for a split that saves nobody an
  install.
