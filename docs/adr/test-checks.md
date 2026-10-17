---
status: accepted
date: 2026-10-17
tags: [lntt, tests, review, mutation]
---

# `lntt check tests`: the test levels, and the mutations a reviewer proposes

## Context

The `tests` lens of `lntt review` judges tests by reading them. Part of that is
computable: which level a test file sits at, whether it opens what its level needs, a
forgotten `.only`, which tests run a changed line. The strongest proof that a test is
worth something, that it fails when the line it guards breaks, is a run, and a
read-only reviewer cannot run anything. Mutation testing that tries every mutant over
the whole suite weighs every line alike and costs a full run per mutant; the useful
mutations are few, and whoever reads the change knows which line a test guards.

## Decision

`tests` is an area of [`lntt check`](./lntt-command.md), the one the `tests` lens reads
([review agents](./review-agents.md)). A test is accepted when it fails for the right
reason, and sits at the lowest level where its assertion can.

- **The levels are configuration.** `tests.levels` lists them lowest first: `name`,
  `files` (globs) and `exclude`, `environment` (reported), `harness` (identifiers a
  file at that level must open: `tx`, `withTestDb`), and the commands that run them
  (`run`, `coverage`, `cwd`, `repeat`, `timeoutSeconds`). `tests.rules` lists the
  patterns the project forbids, each with the `anchor` of its record and, when its own
  suite already asserts the pattern, `assertedBy`, which cites that test instead of
  checking again. `tests.ignore` takes out files named like tests that are not, and
  `tests.assertions` names functions that fail a test by throwing.
- **The checks.**
  - `levels`: every test file (`*.test.*`, `*.spec.*`, or a level's `files`) matches
    exactly one level, and a file that does not open its level's harness fails. The
    pyramid per level, what the diff adds to each, and the jsdom tests that stub a Web
    API are `INFO`: never a threshold.
  - `focus`: `.only`, a new `.skip` or todo, a test with no assertion.
  - `rules`: the lines that match a rule; a rule asserted by the suite is cited. A rule
    whose `anchor` names a record that is not there, or a heading the record does not
    have, fails; headings resolve as GitHub's slugs do (a repeated heading is numbered
    `-1`, `-2`, fenced lines are no heading).
  - `touched` (needs `--base`): the lines the diff changes and the tests that run them,
    from the `coverage` of the test files that import the changed file, or from imports
    alone when a level has no `coverage`. Coverage says which tests to run and which
    lines no test reaches; it is not an acceptance criterion.
  - `mutate <path:line> --text <on the line> --to <mutated>`: applies the mutation,
    runs the tests that import the file (a level's `repeat` times in a row), and
    reports killed (the failing test and its message, `PASS`), survived (`FAIL`), or
    `NOT RUN` when the path leaves the project, the text is not once on that line, the
    tests fail without the mutation, they outlast `timeoutSeconds`, or the file is one
    git ignores (the scratch does not have it).
- **The mutation lives in a scratch git worktree** of the head, with the uncommitted
  files laid over it and the dependencies shared, and is removed when the run ends: the
  working tree is never written. A failure counts as killed only when the same tests
  pass without the mutation.
- **A review round runs the mutations the tests reviewer proposes.** The reviewer ends a
  finding line with ``mutate: `text` => `mutated` ``; between the reviewers and the
  verifiers `lntt review` runs them all on one scratch. A surviving mutant confirms its
  finding and a killed one refutes it, with the run as the proof and no verifier asked;
  a run that could not happen is an undecided proof and the verifiers decide. The
  brief asks for the mutations of the list that matter (a polarity flipped, an argument
  dropped, a guard or early return removed, the optimistic constant returned, the call
  removed), wiring before units.
- **What stays with the model:** whether a test is at the lowest level that can fail for
  the right reason, whether a jsdom test drives a stub, an expected value copied from
  the output instead of the contract, and which mutations to propose.

## Consequences

### Positive

- A level mismatch, a `.only` or a forbidden pattern is found the same way every round,
  by a cheap check.
- "This test would still pass if the line broke" is a run with a named outcome.
- The levels of a project (pelion's, wai's) fit one table, which also tells a new
  contributor where a test goes.

### Negative / accepted risks

- A project must write `tests.levels` with a `run` command before `mutate` works; the
  tests of a line are found from imports, so a test that reaches code only through a
  package name or a spawned process path that is not a string in the test is missed
  and the mutant may survive for want of a test that does run it.
- A mutation is proposed in a line whose text and mutated text hold no
  backtick: the reviewer reports other lines as notes.
- An interrupted run (SIGINT, SIGTERM) leaves its scratch worktree registered under the
  system's temp folder; the working tree is untouched, and `git worktree prune` once
  the `lntt-mutate-*` folder is removed clears the registration.
- A mutation run costs the tests of the files that import the changed file. A timeout
  stops the shell that runs the command; a process it started may outlive it.
- Each scratch worktree copies the links of `node_modules`; a project whose tests need
  built output that is not committed fails without the mutation and is `NOT RUN`.

### When to deviate (revisit triggers)

- Runs take longer than a round can afford: select tests by coverage instead of by
  imports.
- Reviewers' proposals that survive are rarely real gaps: tighten the brief before the
  check.

## Discarded directions

- **Automated mutation testing (Stryker and similar).** Every mutant reruns the whole
  suite, the score weighs every line alike, and the useful mutations are few and chosen
  by whoever knows what the line guards.
- **Mutating the working tree and restoring it.** An interrupt or a crash leaves the
  author's files mutated; the scratch worktree cannot.
- **A process that removes the scratch when `lntt` is interrupted.** A run waits on its
  tests synchronously, so a signal handler cannot run during it; a second process
  watching for `lntt` to end adds a platform dependency (`kill -0`, a fractional
  `sleep`), a race with the tests still writing, and its own tests, for a leftover
  folder in the temp directory.
- **Coverage as an acceptance criterion.** A line run is not a line checked; coverage
  only names the tests to run.
