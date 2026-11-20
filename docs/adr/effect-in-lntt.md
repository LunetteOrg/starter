---
status: accepted # proposed | accepted
date: 2026-11-11
tags: [lntt, effect, errors, processes, signals, tests]
---

# Effect in `lntt`

## Context

`lntt`'s commands hold resources that must be released however the command ends: the
worktree's lock, the agents of a review round and their process groups, a scratch
worktree, the bytes still in a pipe to stdout. Each command releases them by hand, with
`process.on('exit')`, signal handlers, module-level sets of pids and an
`AbortController` shared across the module (`packages/lntt/src/review-cli.ts`, the
spawner and `stopAgentsOnInterrupt`), and every new command repeats the pattern and its
mistakes. The errors a command can end with are not in any signature: a caller learns
them by reading the code. The logic reaches the machine (git, the file system, child
processes, the clock) directly, so it is tested only through the CLI as a process,
against fixture repositories, which is slow and asserts through exit codes and output.

[Effect](https://effect.website) is a TypeScript library that makes these three things
part of the types: a value of type `Effect<A, E, R>` is a program that succeeds with an
`A`, fails with an `E`, and needs the services `R`. Resources are acquired in a *scope*
whose *finalizers* run when the program ends, whether it succeeded, failed or was
*interrupted*; services are provided by *layers*, a live one over Node and an in-memory
one in a test.

## Decision

`@lntt/lntt` is written on Effect: every command, and every module that reaches the machine,
follows the rules below. What reaches nothing is plain functions, and the library a script
imports is on `Promise` (below).

### The dependency

- **`effect` and `@effect/platform-node-shared`, both pinned exactly, at the same
  version.** They are runtime dependencies of `@lntt/lntt`, installed in every project
  that installs `@lntt/lntt` (it runs as `pnpm exec lntt`, from the project's lockfile:
  [agent layer](./agent-layer.md)). `effect` 4.1.4 has no dependencies of its own and
  unpacks to 58 MB: the compiled modules, their sources, their maps and the guide for
  agents (`AGENTS.md`, `ai-docs/`). `@effect/platform-node-shared` unpacks to 0.8 MB and
  brings `ws` and `@types/ws`. Disk is what they cost: a command loads only the modules
  it imports.
- **What every command loads, or what a caller needs without Effect, stays in a module
  that imports none** (`exit.ts`, `src/review/agent-env.ts`); a command on Effect loads
  its Effect modules when it runs.
- **Modules are imported by path** (`effect/Effect`, `effect/Layer`), never from the
  `effect` index. Measured on 2026-11-11 with `effect` 4.1.4, node 24.22.1, median of 21
  fresh processes: the eight modules a command uses load in 23 ms, the index in 84 ms.
- **The Node services are Effect's where `@effect/platform-node-shared` has them**
  (`NodeChildProcessSpawner`, `NodeFileSystem`, `NodeRuntime`), and `lntt`'s own only
  where it has none (git, gh). Code of `lntt`'s own is what Effect does not do.

### Services

What reaches outside the process is a service, and reached only through it: processes
(Effect's `ChildProcessSpawner`: a command in a process group of its own, stopped with a
signal to the group and a forced kill after a delay), the file system (Effect's
`FileSystem`), the clock (Effect's `Clock`, so a test moves time with `TestClock`), git,
GitHub's CLI, and the agents built on processes. A service of `lntt`'s own is declared with
`Context.Service`, its live layer in its module: git is `Git` in
`packages/lntt/src/git/git.ts` and GitHub's CLI is `Gh` in `packages/lntt/src/gh/gh.ts`, their
operations typed and run through the spawner, in the current directory or the one the layer
names (`gitAt`, `ghAt`). A layer takes what changes how a run reaches GitHub or git: `ghAt` a token
(the candidate automation's Projects token is a second layer of `Gh`, its service `Board` in
`packages/lntt/src/ci/candidate-steps.ts`) and a dry run, which prints a write's command instead of
running it; `gitAt` the environment git starts with and a dry run of its push. `Gh.over` runs the
same operations over any runner of gh's arguments, for a spec. The agents
are `Agents` in `packages/lntt/src/review/asking.ts` (one agent run, and what keeps an agent
from starting), its live layer in `packages/lntt/src/review/agents.ts` over the spawner, and
`askAll` the logic over it (a slot per provider, the optional agents' grace, a stop); the test
files a mutation runs are `TestRunner` in `packages/lntt/src/check/mutate.ts` (a shell command in
a process group of its own, stopped with SIGKILL past its timeout), and the areas of `lntt check`
that `lntt review` reads are `Checks` in `packages/lntt/src/check/command.ts`. A
module's logic depends on services, never on `node:` modules, and its test provides in-memory
layers. A command that does not load Effect's `Config` for anything else reads the environment
at the edge, in its parser, and passes it in as an input (the operator's home, `LNTT_MESSAGES_DIR`,
the session's variables as `HostEnv` in `packages/lntt/src/review/orca.ts`): `Config` alone took
some 70 ms to load in #335's measure (`effect` 4.1.4). Code that a command reaches with `Config`
already loaded reads it there (`GITHUB_REPOSITORY` in the base, `CLAUDE_CODE_SESSION_ID` in a
round). The files `lntt` ships beside its code (`agents/`, `skills/`) are read
through the FileSystem from a directory a `Context.Reference` gives, beside `src/` in the
repository and in `dist/`, which a spec places in memory (`PackageDir` in
`packages/lntt/src/sync/project.ts`).

### Errors

- **An expected failure is a tagged error in the signature** (`Data.TaggedError`): an
  agent that exits non-zero, a lock held by another command, a configuration that does
  not validate. The caller handles it by tag (`Effect.catchTag`) or lets it through.
- **A defect is not in the signature:** a bug of `lntt` dies. The edge prints it with its
  stack and exits 1, as it does an expected failure that no caller handled.
- **Exit codes are given at one place, the edge of the command** (the codes are in
  [the `lntt` command](./lntt-command.md#decision); an interrupt below). A module never
  picks an exit code.

### How a command runs, is interrupted and exits

- **A command is one Effect, run by `NodeRuntime.runMain`** with `lntt`'s teardown
  (`runCommand` in `packages/lntt/src/run-command.ts`). On SIGINT or SIGTERM, `runMain`
  interrupts the command: the interrupt runs every finalizer of the command's scope (the
  agents are released), and the command exits 130, whichever the signal. `lntt ci local`
  interrupts itself the same way on SIGHUP and SIGQUIT, at its edge
  (`packages/lntt/src/ci/local.ts`): its steps run in process groups of their own, which a
  closed terminal does not reach.
- **The teardown gives the exit code:** 0 on success (the code of `after` when the command
  gives one, below), the code of an `exit(code)` the command threw, 130 for an interrupt, 1 for
  any other failure or a defect, which it
  prints with `util.inspect` (the error and its stack). It leaves through `leave`
  (`packages/lntt/src/exit.ts`), which lets stdout and stderr drain first: `runMain`
  alone exits at once on any code but 0, and a pipe on macOS takes writes
  asynchronously, so a document written before an exit 3 or 4 would arrive cut.
  `runMain`'s own error reporting is off: its log format is not `lntt`'s.
- **`exit.ts` imports no Effect,** because every command loads it while it reads its
  arguments, before Effect: a usage error exits 2 having loaded none. `effect/Runtime` and
  `NodeRuntime` take about 24 ms each to load (measured on 2026-11-11, `effect` 4.1.4,
  node 24.22.1, median of 11 fresh processes). Running on `runCommand` is what a command
  pays for one way to run: `lntt guide`, which prints a file, took 120 ms before it ran on
  Effect (commit 8b077ee) and 156 ms after (09be0a7), measured on 2026-11-20, `effect` 4.1.4,
  node 24.22.1, median of 21 fresh processes. A command loads `run-command.ts` once its arguments are read.
- **A resource is acquired with its release** (`Effect.acquireRelease`), in the scope of
  the command or of the step that uses it. Nothing on Effect is released from
  `process.on('exit')` or from a signal handler.
- **A child that is not `lntt`'s to stop belongs to no scope:** `caffeinate -i -w <pid>`,
  which keeps macOS awake while `lntt review` runs, exits with `lntt`'s process however it
  ends; the viewer `lntt viewer open` starts detached (Playwright, the system browser) shows
  the page after `lntt` has exited (`packages/lntt/src/local/machine.ts`). Each is started
  through the spawner in a process group of its own, in a scope nothing closes, and let go of
  (`unref`), so it does not keep the process alive; a scope's release would stop it at the end
  of a step, before an executable written just before can start. Where there is no
  `caffeinate` to start (not macOS, not installed) the round goes on; any other failure to
  start it fails the round.
- **What a passing step of `lntt ci local` started in the background outlives the step:**
  the step's command is a resource of the step's scope, released as any other on a timeout,
  the lock's deadline or an interrupt, and a command that fails takes its process group with
  it; one that passes is let go of (`unref`) before its scope closes, so a server it started
  for the job's next steps keeps running, as on a CI runner
  (`packages/lntt/src/ci/runner.ts`).
- **The worktree's lock is a resource of the command's scope** in `lntt review` (a round,
  a reply, `allow`: `lockWorktree` in `packages/lntt/src/worktree/lock.ts`), its heartbeat
  a fiber of the same scope. The agents are fibers of `askAll` inside it, so they are
  released before the lock. `lntt check tests mutate` holds it the same way, in the command's
  scope; inside it, the scratch worktree its mutations run in is a resource of a scope of its
  own, removed before the lock is released, and the mutated file is restored by a finalizer
  (`packages/lntt/src/check/mutate.ts`).
- **An agent's process group is a resource.** Its release, when the agent did not exit
  on its own: SIGTERM to the group, up to five seconds for it to go, then SIGKILL to the
  group (the spawner's `killSignal` and `forceKillAfter`). A timeout, a stop (the round's
  deadline, the optional agents' grace) and an interrupt are interrupts of the agent's
  fiber, so it releases the same way, and `askAll` goes on once the release is done.
- **A step that can hold the event loop keeps the default handling of signals,** and does
  not run under the runner: a jq query that holds the loop is ended by the signal itself
  ([the `lntt` command](./lntt-command.md#decision)). A command on Effect whose last step is
  such a query (`lntt check --query`) runs the rest under the runner and gives that step to
  `runCommand` as `after`: the teardown runs it on the command's success, once `runMain` has
  removed its handlers of SIGINT and SIGTERM (`runMain` in
  `packages/lntt/node_modules/@effect/platform-node-shared/src/NodeRuntime.ts` removes them in
  the fiber's observer, before it calls the teardown), and its code is the exit code. Every
  other command on Effect runs under the runner, one that holds no resource too (`lntt
  branch`, `lntt pr`): one way to run, its expected failures reported at the edge, and 130 for
  a signal.

### The edge, the library and the plain logic

- **The edge of a command is its parser** (`packages/lntt/src/*-cli.ts`, `packages/lntt/src/ci/cli.ts`):
  it reads the arguments, a usage error exiting 2 before Effect loads, and what the command takes
  from the session (the directory, the operator's home, the variables, the platform), and reads
  stdin to its end with `readStdin` (`packages/lntt/src/stdin.ts`) when the command takes it as an
  input (a draft, a hook's input). `lntt branch check --pre-push` reads it inside the command,
  through a `Context.Reference` its spec replaces, so a stdin it cannot read is the command's
  failure.
- **The library is on `Promise`.** `@lntt/lntt` (`packages/lntt/src/index.ts`) and
  `@lntt/lntt/ci` export plain functions and `Promise` functions, so a script that imports them
  needs no Effect, and they export what a script outside `lntt` uses: there is no synchronous
  form of what `lntt` reads on Effect (the configuration, the ci:local lock, the worktree
  adapters, the CI's loaders). A library function whose logic is on Effect (`askAll`,
  `runRound`, `runJobs`, `commitlintConfig`) imports its Effect form with `await import(...)`
  when it is called and runs it with `Effect.runPromise` on Node's layers, its callbacks under
  `Effect.sync`, `Effect.try` and `Effect.tryPromise` (a `Spawn` is the `Agents` layer
  `Agents.fromSpawn`, an `AbortSignal` the stop). A `Spawn` that rejects is that agent's failed
  answer in `askAll`; an ask, a brief or a cited line that throws rejects `runRound` with what it
  threw. A command that does not call it loads no Effect for it.
- **What reaches nothing is plain functions** in modules that import no Effect, with plain specs,
  and the Effect form beside them reads and writes what they compute: the project's configuration
  and the operator profile (`packages/lntt/src/config/project.ts`,
  `packages/lntt/src/config/operator.ts`, read by `packages/lntt/src/config/load.ts`, with
  `ProjectConfig`, the configuration as a service), what `lntt sync` writes
  (`packages/lntt/src/agents.ts`, `packages/lntt/src/skills.ts`, read and written by
  `packages/lntt/src/sync/project.ts`), the rules of the locks (`packages/lntt/src/worktree/holder.ts`,
  `packages/lntt/src/ci/lock-rules.ts`), what the base reads from the names git and GitHub give
  (`packages/lntt/src/base/names.ts`).
- **A sequence of calls to tools with decisions between them is a generator** that yields the
  step it needs (a tool to run, a setup script, a pause, a file, the PATH, the files changed, a
  CircleCI configuration processed) and receives its result: the worktree adapters of `lntt
  worktree start` (`packages/lntt/src/worktree/hosts.ts`) and the loaders of `lntt ci local`
  (`packages/lntt/src/ci/asks.ts`). A driver on Effect runs it over the spawner, the Clock, the
  FileSystem and Git (`packages/lntt/src/worktree/steps.ts`, `packages/lntt/src/ci/host.ts`); a step
  that fails is thrown into the generator, so an adapter catches what it expects as plain code
  does, and what it throws is the command's tagged error. A spec drives the same generator over
  answers of its own.

### Tests beside each module

- **A module's unit test sits beside it, named `*.spec.ts`** (`src/review/agents.ts`,
  `src/review/agents.spec.ts`, which provides an in-memory `ChildProcessSpawner`), as in
  `@lntt/test-utils`, where `*.spec.ts` is a unit test and `*.test.ts` an integration
  test. It runs on vitest with `@effect/vitest`
  (`it.effect`, `it.layer`), with the in-memory layers of the services it uses. The specs
  share one in-memory `FileSystem` (`packages/lntt/src/testing/file-system.ts`), which follows
  Node's semantics where a module relies on them (a missing directory, `wx`, `link` on an
  existing path, `utimes` in seconds), so a spec fails where Node would, and one in-memory
  `ChildProcessSpawner` that answers each command by its name and arguments and records what
  it was asked (`packages/lntt/src/testing/spawner.ts`); `src/testing/` is not published.
- **One `unit` level for the whole repo** (`tests.levels` in `.agents/config.jsonc`), run
  by vitest from the root, whose `vitest.config.ts` only lists the
  packages' own configurations as `projects`. Each package keeps its vitest settings in
  its own `vitest.config.ts`. The `cli` level keeps the end-to-end tests in
  `packages/lntt/test/`, one per main path of a command.
- **The published package holds no test file:** `tsconfig.build.json` does not compile
  them, and `files` in `packages/lntt/package.json` excludes any that would reach
  `dist`. The package's `test` script runs them before the end-to-end tests, so CI runs
  them with `pnpm test`.

### What an agent reads about Effect

`AGENTS.md` sends an agent that writes Effect code to the installed version: the guide
`node_modules/effect/AGENTS.md` (the `LLMS.md` of Effect's repository), and the sources in
`node_modules/effect/src` and `node_modules/@effect/platform-node-shared/src`. An
agent's search tools skip `node_modules`, a folder git ignores, so the paths are named.

### What a project inherits

A project that installs `@lntt/lntt` gets `effect` in its `node_modules`, at the version
`@lntt/lntt` pins. It runs `lntt` and, when it imports the library, gets `Promise`
functions: its commitlint configuration awaits `commitlintConfig()`
([the compatibility rule](./lntt-command.md#gates-and-agent-tools-one-package-two-groups-one-compatibility-rule)).
A project that uses Effect itself
resolves its own version beside `lntt`'s.

`@lntt/lntt/ci` exports the plain logic of a project's CI on the machine (the expressions, the
actions, CircleCI's `when` and mapping, the report, the reading of `ci.local` and
`delivery.candidate`: `ciConfigOf`, `candidateConfigOf`) and the run of a plan on `Promise`
(`runJobs`, `stopRunning`, `machineLoad`). The candidate automation and the check of a tree already
proved belong to their commands, `lntt ci candidate` and `lntt ci proved`, their only callers, and
are not exported.

## Consequences

### Positive

- A resource is released by construction, at the place it is acquired; an interrupt
  or a timeout releases it the same way as a normal ending.
- A function's failures are in its type, and the exit codes are mapped in one place.
- The logic of a command is tested with in-memory services in milliseconds, apart from
  the few end-to-end paths that need the real CLI.

### Negative / accepted risks

- A reader of `lntt` has to know Effect: generators (`Effect.gen`), services, layers,
  scopes. A contributor who knows only Promises reads a module on Effect more slowly.
- 59 MB more in every project's `node_modules`, and Effect's major versions to follow:
  a major bump of `effect` is a change of `lntt` like any other, released in a version
  of `@lntt/lntt`.
- An interrupted command exits 130 for SIGTERM too: a caller can no longer tell the two
  signals apart by the code.
- `@effect/vitest` follows vitest's major versions: the repo moves to a new vitest
  major with it, and with `@lntt/test-utils`, whose vitest peer every template installs.

### When to deviate (revisit triggers)

- A version of `effect` whose start cost, measured as above, passes 50 ms for the
  modules a command uses.
- Effect's source vendored in the repo with `git subtree`, as the Effect team recommends
  for agents (#319): `AGENTS.md` sends the agents there instead of `node_modules`.
- A service `lntt` writes itself (git, gh) appears in `@effect/platform-node-shared`: it
  replaces `lntt`'s own.

## Discarded directions

- **Effect 3.** The major before 4: the process and platform APIs this record uses
  (`effect/process`, the spawner's `killSignal` and `forceKillAfter`) are 4's, and
  starting on 3 means a migration of the migration.
- **`@effect/platform-node`.** The same Node services as `@effect/platform-node-shared`,
  plus an HTTP client and server, sockets and Redis, which bring `undici` and `redis`
  (a required peer) into every project for nothing `lntt` uses.
- **A runner of `lntt`'s own that keeps 143 for SIGTERM.** About twenty-five lines that
  repeat what `runMain` does, to keep a distinction no caller of `lntt` relies on; the
  drain needs only the teardown.
- **`node:test` for the unit tests.** It runs Effects through `Effect.runPromise` with
  the layers provided by hand in every test, where `@effect/vitest` provides them and
  `TestClock`; and `@lntt/test-utils`'s unit tests run on vitest, so one runner serves
  the repo's unit level.
- **A `unit` level per package.** One level per command means one `run` per level;
  vitest's `projects` let one command run every package's configuration.
- **Keeping Promises and adding `using` / `AsyncDisposableStack` for resources.** It
  releases resources at the end of a block, but gives no interruption that reaches a
  running child process, no errors in the signature and no service injection: the
  tests would still go through the CLI.
- **Some modules on Promises beside those on Effect.** Two styles would live side by side for
  good, and a bridge between them would stay: the resources, errors and services this record
  gives a module on Effect would stop at every call into one that is not.
- **A synchronous library form beside the Effect one** (`findConfig`, `acquireLock`,
  `startOrca`, `githubJobs`, kept as thin shells over `node:`). A second implementation of each
  reading of the machine, kept in step with the first by hand; a script that needs the machine
  awaits a `Promise` form instead, as a commitlint configuration awaits `commitlintConfig()`.
- **The whole package at once.** One change that rewrites every command can be reviewed
  only as a whole, and keeps the package out of a release until it is all done: a
  module moves with its tests beside it, in a change of its own.
