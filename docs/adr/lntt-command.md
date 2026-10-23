---
status: accepted
date: 2026-10-22
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
lntt path | validate | get | set | operator | sync | guide | local app | viewer | browser | refs
lntt check [agents-md | skills | decisions [structure | numbers] | tests [levels | focus | rules | touched | mutate] | body] | check cite
lntt branch name | check | rename
lntt pr block
lntt review [reply | allow]
lntt worktree start
lntt ask | inbox | answer
lntt ci local | candidate
```

- **One entry point, one module per command group.** `bin/lntt.ts` dispatches to
  `src/cli.ts` (configuration, operator, `AGENTS.md`, local apps, viewer, browser),
  `src/check-cli.ts`, `src/branch-cli.ts`, `src/review-cli.ts`, `src/worktree-cli.ts`,
  `src/refs-cli.ts`, `src/pull-request-cli.ts`, `src/messages-cli.ts` (`ask`, `inbox`,
  `answer`) and `src/ci/cli.ts`.
  A group loads only when it runs. What a script needs as a library, `@lntt/lntt`
  exports too (`resolveRefs` and `mentions` for `lntt refs`).
- **What a person types is what an agent runs.** Skills, workflows, git hooks and
  `orca.yaml` call `lntt`, never a package's files by path, with one exception: the
  candidate workflow runs `node packages/lntt/bin/lntt.ts`, because it installs only
  this package and its dependencies.
- **Output for scripts.** stdout carries only the result: a bare value (`lntt path`,
  `lntt branch name`), JSON (`lntt get`, `lntt operator`, `lntt refs`), or one JSON line per item
  (`lntt worktree start`, whose `issue` is null for a coordinator and which names the `parent`
  of a child, followed by the brief when no agent was started, for the
  person who will start one; `lntt check --json`), a document for an agent (`lntt guide
  <skill>`: a comment naming the folder its relative links start from, then the guide;
  `lntt browser`: the driver, then one line per operation),
  or a report for a person (`lntt check` without `--json`); progress and child-process output go to stderr. Exit codes:
  0 ok, 1 a configuration error, a red result or a check that cannot run (one line on
  stderr), 2 a usage error, 3 a stop that a person decides on (`lntt review` past
  `delivery.review.maxRounds`), an interrupted command 128 plus the signal (130 for
  Ctrl-C); a defect of `lntt` itself exits 1 with its stack trace.
- **`lntt check` is the one verb for what is checked without judgement**, in areas:
  `decisions` and `tests`, whose results their review lenses read, and `agents-md`,
  `skills` and `body` (the retrospective block of a pull request body and of the
  template), which no lens needs; a lens's checks are the area named after it. Alone it runs every
  area, which is what CI runs. Every check reports `PASS`, `FAIL` or `NOT RUN` with its
  reason, so a check that did not run is never read as one that passed, and `INFO` for
  what it prints
  without a verdict; `--json` gives one line per result (`area`, `check`, `status`,
  `path`, `line`, `message`), `--base <ref>` limits a check to what the diff touches
  where that makes sense. What a project ships to others (a shared package, a skill)
  cites the records of the project that installs it: `recording.externalReferences`
  names those files with the reason, and a glob that matches nothing fails. A new
  deterministic check is a check of an area, or a new area, never a script beside a
  skill.
- **No aliases for old names.** A renamed command answers only to its new name, so its
  callers (workflows, skills, the README) change with it, in the same release: the
  shared skills ship in `@lntt/lntt` with the command they call.

### Gates and agent tools: one package, two groups, one compatibility rule

`lntt` holds commands of two natures. A **gate** gives a verdict a project relies on,
so it gives the same answer on the same commit today and in a month. An **agent tool**
helps an agent work and blocks nothing; some of its code follows hosts that release
faster than a project bumps its dependencies. Whether the two ship as one package
rests on these criteria:

1. **A gate is reproducible on the same commit.** The CI workflow runs
   `pnpm exec lntt check` and `lntt branch check` (`.github/workflows/ci.yml`), the
   git hooks run `lntt branch check --pre-push` and commitlint with `@lntt/lntt`'s
   configuration (`lefthook.yml`, `pre-push` and `commit-msg`). Their answer is fixed
   only by the project's lockfile. A red of `lntt ci local` for a timeout is the
   machine's, never a verdict on the code (`packages/lntt/src/ci/report.ts`).
2. **The host adapters follow the hosts' release cadence** (#137): Orca 1.4.229 moved
   the agent's handle and `lntt worktree start` reported the agent as unknown until
   #126. A fix reaches a project only with a release
   ([delivery](../process/delivery.md#releasing)) and that project's bump. The
   adapters' cost lands only in a project that pins a released `@lntt/lntt`: the
   template does not depend on it yet (#60), and this repo runs it from the workspace.
3. **The configuration is a contract between versions.** The agent tools read
   `delivery.review` (`reviewConfig` in `packages/lntt/src/review.ts`), `coordinator`
   (`gateOf` in `packages/lntt/src/coordinator.ts`) and `local` (`localApp` in
   `packages/lntt/src/local.ts`); `lntt worktree start` reads `delivery.candidate`
   and `delivery.branches` through the gate's branch code. Every read validates the
   whole file with Ajv (`loadConfig` in `packages/lntt/src/index.ts`) against a schema
   that rejects unknown fields (`additionalProperties: false` in
   `packages/lntt/schema/config.schema.json`), so the contract is the whole file.
4. **The skills call both groups.** `review` calls `lntt review`, `lntt check cite` and
   `ci:local`; `decisions` calls `lntt check decisions` and is a lens of `lntt review`;
   `coordinate` calls `lntt worktree start`, the mailbox and `lntt get`; `run-local`
   calls `lntt get`, `lntt local app` and `lntt viewer`; `retrospective` calls `lntt get`,
   `lntt pr block` and `lntt check body`; only `commit-message` stays on the gate side (`lntt get`, commitlint). In the code, `lntt review` imports the check
   areas and the mutations and runs them in-process (`packages/lntt/src/review-cli.ts`
   imports `runArea` and `mutateAll`), and `lntt worktree start` names branches with
   the gate's code (`packages/lntt/src/worktree-cli.ts` imports `branchName` and
   `checkBranch`).
5. **The cost of a split.** A second package needs its placeholder published by hand
   ([publishing](./cli-runtime-and-publishing.md#one-version-for-every-published-package-one-release)),
   a second release stream beside the one version `scripts/packages-version.mts`
   enforces, and an install path per host: a plugin reaches Claude Code only, every
   other host needs `npx` (#147).

Criterion 1 holds whatever the packaging; criteria 3 to 5 cost a split from its first
release, while criterion 2 pays only in a project that pins a released `@lntt/lntt`.
So:

- **The commands stay in one package, `@lntt/lntt`, pinned by the project's
  lockfile**, until the split's trigger fires (below). One version runs the gates,
  the agent tools and the skills, so `lntt review`'s checks in-process are CI's.
- **The commands belong to two groups.** The pinned group's interface (a command, a
  flag, an exit code, a `--json` field) is what the agent side calls, so it changes
  only by addition:

  | Pinned by the project: gates and what CI runs | Agent tools |
  |---|---|
  | `lntt check [area]`, `lntt check cite`: deterministic, read only the commit, or for `body` the pull request body they are given | `lntt review [reply \| allow]`: its outcome is an opinion, wired into no CI |
  | `lntt ci local`: CI's jobs on the machine; `lntt ci candidate`: what the candidate workflow runs on GitHub, at the default branch's version, which the workflow checks out ([delivery](../process/delivery.md#the-candidate-automation)) | `lntt worktree start`: the Orca and Herdr adapters |
  | `lntt branch check`, and `branch name` and `branch rename`, so the name an agent gets is the one the gate accepts | `lntt ask \| inbox \| answer` |
  | `lntt validate \| get \| set \| path`: they hold the schema; `set` writes a tracked file | `lntt guide`: it prints the skills |
  | `lntt sync`: it writes tracked files (the `AGENTS.md` block, the skill stubs) that `lntt check` verifies | `lntt operator`: personal context, read by no gate; `lntt pr block`: the empty retrospective block, for the template and the skill |
  | the commitlint configuration (the `@lntt/lntt` export) | `lntt local app`, `lntt viewer` |
  | the configuration schema | the plugin's hooks; once they exist, `lntt refs` (#144) and `lntt doctor` (#124) |

- **The configuration schema follows one compatibility rule.** Its version is the
  `@lntt/lntt` version in the project's lockfile; the file carries none.
  - It only grows: a new field or section is optional, never `required`, and its
    absence means the behaviour from before it existed. An enum only gains values.
    A newer `lntt` therefore reads an older file; the rule needs a test that
    validates a configuration of each released version against the current schema
    ([accepted risks](#negative--accepted-risks)).
  - An older `lntt` rejects a field it does not know, as `additionalProperties: false`
    does: an unknown field is a typo until proven otherwise. A project writes a new
    field after bumping `@lntt/lntt` to a version that knows it, and `lntt validate`
    at that version is the check.
  - A missing file means the defaults (`NoConfigError` in
    `packages/lntt/src/files.ts`); a file that does not validate stops the command
    with the error, as `lntt review` does (`loaded` in
    `packages/lntt/src/review-cli.ts`). The rule is that an invalid file gets an
    error, not the defaults; two commands still answer it with their defaults
    ([accepted risks](#negative--accepted-risks)).
  - A removal or a rename is a breaking change, the one release where an older file
    stops validating: the release knows both names, the gate fails on the old one and
    names the new one while the agent tools still read it, and a later release drops
    the old name. Renaming one of the fixed areas of the
    [agent layer](./agent-layer.md#an-installed-skill-is-never-edited) is such a
    change, and these two releases are its coordination.
- **When the split's trigger fires**, the agent tools leave `@lntt/lntt` for a second
  command at its latest version, shipped with the plugin and through `npx`. The pinned
  group stays where it is. The skills become full files beside the agent tools and the
  stubs of
  [the agent layer](./agent-layer.md#the-shared-skills-come-with-lntt-a-project-holds-their-stubs)
  go; a skill calls the pinned group through `pnpm exec lntt`, the project's version.
  `lntt review` runs `pnpm exec lntt check --json` instead of the check in-process,
  and `lntt worktree start` calls `lntt branch name`, so their results stay CI's. An
  agent tool older than the project's `@lntt/lntt` says so and stops, since it may not
  know a field the file uses. The plugin's hooks ship with the agent tools (#147).

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
- A host's change reaches a project's agent tools only with a release and that
  project's bump, until the split's trigger fires.
- `lntt worktree start` and the commitlint configuration answer a file that does not
  validate with their defaults (`projectConfig` in
  `packages/lntt/src/worktree-cli.ts`, `commits` in `packages/lntt/src/commitlint.ts`),
  against the compatibility rule, and no test validates each released version's
  configuration: until the work that follows this record closes both gaps, the rule
  rests on review.

### When to deviate (revisit triggers)

- A group of commands is wanted by projects that are not Lunette projects (the CI
  runner alone, for example): it becomes a package of its own, with its own command.
- **The split's trigger:** a host change breaks an adapter in a project that pins a
  released `@lntt/lntt`, and the fix waits for that project's bump. The agent tools
  then leave the package
  ([gates and agent tools](#gates-and-agent-tools-one-package-two-groups-one-compatibility-rule)).
- An agent tool needs a gate's interface to change other than by addition: the two
  groups are coupled tighter than the table says, and a split would make each such
  change a breaking release of the gates.
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
- **Every command at its latest version, gates included**, as personal plugins ship
  skills and tools. A gate would answer differently on the same commit a month later,
  and CI would turn red on code nobody changed.
- **Two packages, both pinned.** Two names and two versions to keep, and an adapter fix
  still waits for each project's bump.
- **One package, bumped by a bot as soon as it releases.** An adapter fix then brings
  every gate change of the release with it, and a gate that turns red blocks the fix.
- **A schema that ignores unknown fields**, so an older gate reads a newer file. A
  misspelled key in the file that configures the gates would silently take its default.
- **A version field in the configuration file.** It is a second copy of the version the
  lockfile already pins, to keep in step by hand.
- **Split now**: the agent tools in a second command at its latest version, from the
  first release. It pays criteria 3 to 5 from that release for an adapter gain that
  starts only in a project pinning a released `@lntt/lntt`, which the trigger above
  waits for.
- **The skills split by group**, pinned stubs for the gate skills and full files at the
  latest version for the others. Only `commit-message` stays on one side; the others
  call both groups, and a project would keep two install paths.
- **An agent tool, once split, running the check areas in-process at its own
  version.** Its results would differ from CI's on the same commit.
