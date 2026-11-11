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

`@lntt/lntt` is written on Effect, module by module, until every module has moved; a
module that moved stays on Effect. A module moved to Effect follows the rules below; a
module not yet moved keeps working as it is, and the two meet at a bridge (below).

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
  where it has none (git). Code of `lntt`'s own is what Effect does not do.

### Services

What reaches outside the process is a service, and reached only through it: processes
(Effect's `ChildProcessSpawner`: a command in a process group of its own, stopped with a
signal to the group and a forced kill after a delay), the file system (Effect's
`FileSystem`), the clock (Effect's `Clock`, so a test moves time with `TestClock`), git,
and the agents built on processes. A service of `lntt`'s own is declared with
`Context.Service`, its live layer in its module: git is `Git` in
`packages/lntt/src/git/git.ts`, its operations typed and run through the spawner. A module's
logic depends on services, never on `node:` modules, and its test provides in-memory layers.

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
  agents are released), and the command exits 130, whichever the signal. The commands
  not yet on Effect (`lntt check tests mutate`, `lntt ci local`) exit 128 plus the
  signal, 143 for SIGTERM, until they move.
- **The teardown gives the exit code:** 0 on success, the code of an `exit(code)` the
  command threw, 130 for an interrupt, 1 for any other failure or a defect, which it
  prints with `util.inspect` (the error and its stack). It leaves through `leave`
  (`packages/lntt/src/exit.ts`), which lets stdout and stderr drain first: `runMain`
  alone exits at once on any code but 0, and a pipe on macOS takes writes
  asynchronously, so a document written before an exit 3 or 4 would arrive cut.
  `runMain`'s own error reporting is off: its log format is not `lntt`'s.
- **`exit.ts` imports no Effect,** because every command loads it: `effect/Runtime` and
  `NodeRuntime` take about 24 ms each to load (measured on 2026-11-11, `effect` 4.1.4,
  node 24.22.1, median of 11 fresh processes), against 150 ms for a whole `lntt get`.
  Only a command on Effect loads `run-command.ts`.
- **A resource is acquired with its release** (`Effect.acquireRelease`), in the scope of
  the command or of the step that uses it. Nothing on Effect is released from
  `process.on('exit')` or from a signal handler.
- **The worktree's lock is a resource of the command's scope** in `lntt review` (a round,
  a reply, `allow`: `lockWorktree` in `packages/lntt/src/worktree/lock.ts`), its heartbeat
  a fiber of the same scope. The agents run in a scope inside it, so they are released
  before the lock. `lntt check tests mutate`, still on Promises, takes the lock through
  the module's Promise entry (`packages/lntt/src/worktree-lock.ts`), which loads Effect to
  run the same acquisition and releases the lock on the process's exit until that command
  moves.
- **An agent's process group is a resource.** Its release, when the agent did not exit
  on its own: SIGTERM to the group, up to five seconds for it to go, then SIGKILL to the
  group (the spawner's `killSignal` and `forceKillAfter`). A timeout is an interrupt of
  the agent's fiber, so it releases the same way.
- **A reading command keeps the default handling of signals** (a jq query that holds
  the event loop is ended by the signal itself,
  [the `lntt` command](./lntt-command.md#decision)): only a command that holds resources runs under the runner's handlers.

### The bridge, while modules move

A module on Effect exposes, besides its Effects, the `Promise` functions its callers
still use (the `Spawn` of `askAll` is one), run through `FiberSet.makeRuntimePromise`
with the caller's `AbortSignal` (`withAgents` in `packages/lntt/src/review/agents.ts`).
Each run is a fiber of the command's scope: an abort interrupts it and the promise
settles once its finalizers have run, and an interrupt of the command interrupts every
run still going and ends once they are all released. The command's own Promise code runs
under `Effect.tryPromise`, whose signal an interrupt aborts. The sync code of modules not
yet moved that a module on Effect needs (for `lntt review`: the project's configuration,
the place of the state store, the base, `lntt check`'s areas, the agents' CLIs, the limit's
message, Orca's subagents) is reached through a service of that module, its bridge
(`ReviewBridge` in `packages/lntt/src/review/bridge.ts`): the live layer runs the code under
`Effect.try`, and what it throws is a tagged error of the bridge (`ReviewFailed`), reported
by its message like any expected failure; the unit test gives the bridge's in-memory layer.
A defect of the Effect code reaches the edge with its stack. A piece leaves the bridge when
its module moves to Effect. The library API of
`@lntt/lntt` (`packages/lntt/src/index.ts`) stays on `Promise`, so a script that imports
it needs no Effect.

### Tests beside each module

- **A module's unit test sits beside it, named `*.spec.ts`** (`src/review/agents.ts`,
  `src/review/agents.spec.ts`, which provides an in-memory `ChildProcessSpawner`), as in
  `@lntt/test-utils`, where `*.spec.ts` is a unit test and `*.test.ts` an integration
  test. It runs on vitest with `@effect/vitest`
  (`it.effect`, `it.layer`), with the in-memory layers of the services it uses. The specs
  share one in-memory `FileSystem` (`packages/lntt/src/testing/file-system.ts`), which follows
  Node's semantics where a module relies on them (a missing directory, `wx`, `link` on an
  existing path, `utimes` in seconds), so a spec fails where Node would; `src/testing/` is
  not published.
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
`@lntt/lntt` pins, and nothing in its own code changes: it runs `lntt` and, when it
imports the library, gets `Promise` functions. A project that uses Effect itself
resolves its own version beside `lntt`'s.

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
- While modules move, two styles live side by side, and the bridge is code that exists
  only for the migration.
- An interrupted command exits 130 for SIGTERM too: a caller can no longer tell the two
  signals apart by the code. Until every command moves, the commands not on Effect still
  exit 143 for SIGTERM.
- `@effect/vitest` follows vitest's major versions: the repo moves to a new vitest
  major with it, and with `@lntt/test-utils`, whose vitest peer every template installs.

### When to deviate (revisit triggers)

- A version of `effect` whose start cost, measured as above, passes 50 ms for the
  modules a command uses.
- Effect's source vendored in the repo with `git subtree`, as the Effect team recommends
  for agents (#319): `AGENTS.md` sends the agents there instead of `node_modules`.
- A service `lntt` writes itself (git) appears in `@effect/platform-node-shared`: it
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
- **Keeping the modules not yet moved on Promises.** Two styles would live side by side for
  good, and the bridge between them would stay: the resources, errors and services this
  record gives a module on Effect would stop at every call into one that is not.
- **The whole package at once.** One change that rewrites every command can be reviewed
  only as a whole, and keeps the package out of a release until it is all done: a
  module moves with its tests beside it, in a change of its own.
