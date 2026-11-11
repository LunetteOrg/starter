---
status: proposed # proposed | accepted
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

`@lntt/lntt` is written on Effect, module by module. A module moved to Effect follows
the rules below; a module not yet moved keeps working as it is, and the two meet at a
bridge (below).

### The dependency

- **`effect` and `@effect/platform-node-shared`, both pinned exactly, at the same
  version.** They are runtime dependencies of `@lntt/lntt`, installed in every project
  that installs `@lntt/lntt` (it runs as `pnpm exec lntt`, from the project's lockfile:
  [agent layer](./agent-layer.md)). `effect` 4.1.4 has no dependencies of its own and
  unpacks to 58 MB: the compiled modules, their sources, their maps and the guide for
  agents (`AGENTS.md`, `ai-docs/`). `@effect/platform-node-shared` unpacks to 0.8 MB and
  brings `ws` and `@types/ws`. Disk is what they cost: a command loads only the modules
  it imports.
- **Modules are imported by path** (`effect/Effect`, `effect/Layer`), never from the
  `effect` index. Measured on 2026-11-10 with `effect` 4.1.3, node 24.22.1, median of 21
  fresh processes:
  the eight modules a command uses load in 21 ms, the index in 73 ms.
- **The Node services are Effect's where `@effect/platform-node-shared` has them**
  (`NodeChildProcessSpawner`, `NodeFileSystem`, `NodeRuntime`), and `lntt`'s own only
  where it has none (git). Code of `lntt`'s own is what Effect does not do.

### Services

What reaches outside the process is a service, and reached only through it: processes
(Effect's `ChildProcessSpawner`: a command in a process group of its own, stopped with a
signal to the group and a forced kill after a delay), the file system (Effect's
`FileSystem`), the clock (Effect's `Clock`, so a test moves time with `TestClock`), git,
and the agents built on processes. A service of `lntt`'s own is declared with
`Context.Service`, its live layer in its module. A module's logic depends on services,
never on `node:` modules, and its test provides in-memory layers.

### Errors

- **An expected failure is a tagged error in the signature** (`Data.TaggedError`): an
  agent that exits non-zero, a lock held by another command, a configuration that does
  not validate. The caller handles it by tag (`Effect.catchTag`) or lets it through.
- **A defect is not in the signature:** a bug of `lntt` dies, and the edge prints its
  stack and exits 1, as today.
- **Exit codes are given at one place, the edge of the command,** from the error's tag
  ([the `lntt` command](./lntt-command.md#decision): 0, 1, 2, 3, 4, and 128 plus the
  signal). A module never picks an exit code.

### How a command runs, is interrupted and exits

- **A command is one Effect, run by `NodeRuntime.runMain`** with `lntt`'s teardown
  (`packages/lntt/src/exit.ts`). On SIGINT or SIGTERM, `runMain` interrupts the
  command: the interrupt runs every finalizer of the command's scope (the agents are
  stopped, the lock released), and the command exits 130, whichever the signal. The
  teardown maps the ending to its exit code and lets stdout and stderr drain before the
  process exits: `runMain` alone exits at once on any code but 0, and a pipe on macOS
  takes writes asynchronously, so a document written before an exit 3 or 4 would arrive
  cut. The commands not yet on Effect (`lntt check tests mutate`, `lntt ci local`) exit
  128 plus the signal, 143 for SIGTERM, until they move.
- **A resource is acquired with its release** (`Effect.acquireRelease`), in the scope of
  the command or of the step that uses it. Nothing is released from `process.on('exit')`
  or from a signal handler.
- **An agent's process group is a resource.** Its release, when the agent did not exit
  on its own: SIGTERM to the group, up to five seconds for it to go, then SIGKILL to the
  group (the spawner's `killSignal` and `forceKillAfter`). A timeout is an interrupt of
  the agent's fiber, so it releases the same way.
- **A reading command keeps the default handling of signals** (a jq query that holds
  the event loop is ended by the signal itself, [the `lntt` command](./lntt-command.md#decision)):
  only a command that holds resources runs under the runner's handlers.

### The bridge, while modules move

A module on Effect exposes, besides its Effects, the `Promise` functions its callers
still use (the `Spawn` of `askAll` is one), run with `Effect.runPromise` and the
caller's `AbortSignal`: an abort interrupts the fiber, and the promise settles once its
finalizers have run. The library API of `@lntt/lntt` (`packages/lntt/src/index.ts`)
stays on `Promise`, so a script that imports it needs no Effect.

### Tests beside each module

- **A module's unit test sits beside it, named `*.spec.ts`** (`src/review/agents.ts`,
  `src/review/agents.spec.ts`), as in `@lntt/test-utils`, where `*.spec.ts` is a unit
  test and `*.test.ts` an integration test. It runs on vitest with `@effect/vitest`
  (`it.effect`, `it.layer`), with the in-memory layers of the services it uses.
- **One `unit` level for the whole repo** in `tests.levels`: the `*.spec.ts` files under
  `packages/*/src/`, run by vitest from the root, whose `vitest.config.ts` only lists the
  packages' own configurations as `projects`. Each package keeps its vitest settings in
  its own `vitest.config.ts`. The `cli` level keeps the end-to-end tests in
  `packages/lntt/test/`, one per main path of a command.
- **The published package holds no test file:** `tsconfig.build.json` does not compile
  them, and `files` in `packages/lntt/package.json` excludes any that would reach
  `dist`.

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

- A module that moved shows no gain in lines, test time or clarity against the code
  it replaced: the next modules stay on Promises and this record is rewritten.
- A version of `effect` whose start cost, measured as above, passes 50 ms for the
  modules a command uses.
- Effect's source vendored in the repo with `git subtree`, as the Effect team recommends
  for agents (#319): `AGENTS.md` sends the agents there instead of `node_modules`.
- A service `lntt` writes itself (git) appears in `@effect/platform-node-shared`: it
  replaces `lntt`'s own.

## Discarded directions

- **Effect 3.** Stable and widely used, but 4 is the current major, with a smaller
  core and the APIs Effect will keep; starting on 3 means a migration of the migration.
- **`@effect/platform-node`.** The same Node services as `@effect/platform-node-shared`,
  plus an HTTP client and server, sockets and Redis, which bring `undici` and `redis`
  (a required peer) into every project for nothing `lntt` uses.
- **A runner of `lntt`'s own that keeps 143 for SIGTERM.** About twenty-five lines that
  repeat what `runMain` does, to keep a distinction no caller of `lntt` relies on; the
  drain needs only the teardown.
- **`node:test` for the unit tests.** It runs Effects through `Effect.runPromise` with
  the layers provided by hand in every test, where `@effect/vitest` provides them and
  `TestClock`; and the repo's unit tests already run on vitest.
- **A `unit` level per package.** One level per command means one `run` per level;
  vitest's `projects` let one command run every package's configuration.
- **Keeping Promises and adding `using` / `AsyncDisposableStack` for resources.** It
  releases resources at the end of a block, but gives no interruption that reaches a
  running child process, no errors in the signature and no service injection: the
  tests would still go through the CLI.
- **The whole package at once.** A rewrite with no module to measure first: the
  prototype on the agents of `lntt review` is the measure.
