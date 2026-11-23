---
status: proposed # proposed | accepted
date: 2026-11-23
tags: [lntt, effect, architecture, hexagonal, ports, adapters, cli, tests]
---

# The shape of `lntt`'s code

## Context

`@lntt/lntt` runs on Effect ([effect-in-lntt](./effect-in-lntt.md)), and its services already
have live and in-memory layers. What the code does not have is one place for each concern:

- **One command is spread across unrelated files.** The board is `board-cli.ts` (arguments),
  `board/command.ts` (the program), `board.ts` and `board-ready.ts` (rules) and `board/github.ts`
  (GraphQL), with no name that tells which is which.
- **The services are shaped by the technology, not by what `lntt` needs.** `Gh` is one service
  with every command's operations and a generic `graphql(query, vars)`; the board's program sends
  GraphQL strings through it, so a spec of `lntt board` answers GraphQL, and a board on GitLab
  would change the program. Git is reached through `gitAt`, `GitIn` and nine inline
  `ChildProcess.make`, so the worktree workflow is git's worktree, by construction.
- **Two dispatchers** (`bin/lntt.ts`, `src/cli.ts`) and the handling of a usage error copied in
  six parsers.
- **The same task done several ways:** the configuration read through `ProjectConfig` in some
  commands and with `loadConfig` in others; test layers named `memory`, `at`, `fromSpawn`, `none`,
  `over`, or missing.
- **Files that hold several roles** (`review.ts`, 912 lines; `ci/candidate-steps.ts`, 846;
  `gh/gh.ts`, 593) and three import cycles kept alive by dynamic `import()`.

The goals of `lntt` are a board, a version control and a way of isolating work that can each be
replaced: GitHub Projects by GitLab or another tracker, git by Jujutsu, a worktree per issue by
another way of isolating work, the history kept elsewhere until it is published.

## Decision

`lntt`'s code is **hexagonal, per area**: the rules of an area know nothing of the machine, the
machine is reached through ports written in the area's terms, and the technology lives only in
adapters, chosen at the edge.

### An area and its folders

An area is a feature of `lntt` (`board`, `worktree`, `review`, `ci`, `check`, `config`, …). Its
folder shows the hexagon:

```
src/
  main.ts                 the CLI: every area's command, the layers, the exit codes
  lib/                    the library a script imports (index.ts, ci.ts)
  board/
    domain/               plain types and functions: no Effect, no node:
    ports/                Context.Service interfaces, in the area's terms
    adapters/             one file per technology: github.ts, memory.ts
    app/                  the use cases: Effect programs that ask only for ports
    cli/                  the area's Command (effect/cli)
  platform/               adapters shared across areas: process, git, gh, fs, config
```

| Folder | May import |
|---|---|
| `domain/` | other `domain/` files |
| `ports/` | `domain/`, Effect |
| `app/` | `domain/`, `ports/`, Effect |
| `adapters/` | `domain/`, `ports/`, `platform/`, Effect |
| `cli/` | `domain/`, `app/`, `ports/`, Effect's CLI |
| `main.ts`, `lib/` | anything: they compose |

A file has one responsibility: one that needs an "and" to be described is two files. Biome's
`noImportCycles` keeps the graph acyclic.

### Ports in the domain's terms

- **A port says what the area needs, not how a tool does it.** The board reads its state and
  applies a step:

  ```ts
  class BoardStore extends Context.Service<BoardStore, {
    readonly read: Effect.Effect<BoardState, BoardFailed>
    readonly apply: (step: Step) => Effect.Effect<void, BoardFailed>
  }>()('BoardStore') {}
  ```

  GraphQL lives in `board/adapters/github.ts` and nowhere else; a board on GitLab is another
  adapter beside it.
- **Where the technology is a standard, the port takes its concepts, not its commands.** Version
  control is two ports, by intent: `Workspace` (where the work on an issue happens: a git
  worktree, a clone, a Jujutsu workspace, a branch in place) and `History` (how the work is
  recorded and published: commits and a push, Jujutsu changes and bookmarks, a store that is
  published at the end). A use case never names `git add`, a staging area or a worktree.
- **Each port has one way in.** The configuration is the `ProjectConfig` port; `loadConfig` is
  its adapter's. A process is started only in `platform/process` (`run`, `which`), used by
  adapters; a use case never starts one.
- **The place is part of the layer.** An adapter bound to a directory is built for it; a part of
  a program that works elsewhere gets its own layer, provided to that part alone:

  ```ts
  const created = yield* Workspace.start(issue)
  yield* setUp.pipe(Effect.provide(HistoryGit.at(created.path)))
  ```

### Adapters

- **An adapter is a separate export, named `<Port><Technology>`:** `BoardStoreGitHub`,
  `BoardStoreMemory`, `LedgerFs`. A port's file imports none of its adapters; only `main.ts`,
  `lib/` and the tests do.
- **Every port has a `memory` adapter**, which starts from a given state and records what it was
  asked, so a spec asserts the state that results, not the strings sent to a tool.

### The CLI and the library are driving adapters

- **The CLI is `effect/cli`.** Each area exports a `Command` (its flags, arguments, description
  and handler); `main.ts` composes them under `lntt`, with `--json` and `--query` as global flags.
  Help and shell completion are generated from them.
- **`main.ts` gives the exit codes** of [the `lntt` command](./lntt-command.md#decision): a
  `CliError` is a usage error and exits 2; the rest are
  [effect-in-lntt](./effect-in-lntt.md#how-a-command-runs-is-interrupted-and-exits)'s.
- **The library is in `lib/`:** its `Promise` functions (`commitlintConfig()`, `runJobs`, …) run a
  use case with its live layers. No file in an area imports `lib/`.

### Names

An exported name says what it is read alone, in an import or a search across the package:
`ReviewVerdict`, `ReadyVerdict`, `LockVerdict`; `AgentsFile`, `AgentProcess`, the port `Agents`.
A short name stays inside the `domain/` file that defines it.

### Tests

| Kind | Name and place | Runs against |
|---|---|---|
| unit | `*.spec.ts` beside the file | nothing real: plain functions, use cases over `memory` adapters, a `Command` over `Command.runWith` |
| integration | `*.test.ts` beside the adapter | the real service: git, the file system and processes in a temp dir; GitHub on a sandbox repository, in CI only, skipped and said so elsewhere |
| end-to-end | `packages/lntt/test/<area>/*.test.ts` | the `lntt` binary |

Each kind is a level of `tests.levels` in `.agents/config.jsonc`.

### Moving there

An area moves in a change of its own, with its tests: `board` first, as the pilot that settles
the shape, `review` last. Biome's rules for the folders are turned on per area as each one moves.
This record is accepted when the pilot is merged; [effect-in-lntt](./effect-in-lntt.md) and
[lntt-command](./lntt-command.md) are rewritten, where they describe the parsers, the dispatch and
the library, in the change that moves the code they describe.

## Consequences

### Positive

- A replaced technology is a new adapter and a layer chosen in `main.ts`: the use cases and their
  specs do not change.
- A reader finds a concern by its folder: the rules in `domain/`, the use case in `app/`, the
  technology in `adapters/`.
- A spec describes the area (a board in this state) instead of a tool's protocol.
- One CLI library: no parser, help text or usage-error handling of `lntt`'s own.

### Negative / accepted risks

- Every command loads Effect, `lntt get` included: what `effect/cli` costs at start is accepted.
- More, smaller files and services; a port per need instead of one `Gh`.
- The help's format and some option syntax change with `effect/cli`; end-to-end tests that read
  usage messages change with them.
- The GitHub adapter's integration tests run only where a token is: locally they are skipped.

### When to deviate (revisit triggers)

- `lntt get`, measured as in [effect-in-lntt](./effect-in-lntt.md), slower than a hook can wait.
- A port with a single adapter that no test or plan replaces, whose indirection only costs.
- `effect/cli` unable to express a command `lntt` needs.

## Discarded directions

- **Folders by role at the top** (`domain/board.ts`, `adapters/github/board.ts`). The hexagon is
  visible, but following one command means jumping across the tree.
- **A folder per command with fixed files** (`args.ts`, `logic.ts`, `program.ts`). One file per
  layer says nothing about which port a program reaches or which technology an adapter wraps.
- **Ports shaped by the technology** (`Gh.graphql`, `Git` commands). They tie each use case to
  GitHub and git, which the goals of `lntt` allow to change.
- **A dispatcher and parsers of `lntt`'s own**, with a usage error before Effect loads. It saves
  some tens of milliseconds at start, and keeps a parser, help text and error handling to
  maintain by hand.
- **Adapters as static members of the port** (`BoardStore.github`). The port's file would import
  GitHub, the file system and gh: the most central file would know every technology.
- **End-to-end tests inside each area** (`src/board/test/`). An end-to-end test runs the whole
  binary and often crosses areas, and `src/` would hold files the build must exclude.
