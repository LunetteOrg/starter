---
status: accepted
date: 2026-11-10
tags: [lntt, tests, review, mutation]
---

# `lntt check tests`: the test levels, and the mutations run by hand

## Context

The `tests` lens of `lntt review` judges tests by reading them. Part of that is
computable: which level a test file sits at, whether it opens what its level needs, a
forgotten `.only`, which tests run a changed line. The strongest proof that a test is
worth something, that it fails when the line it guards breaks, is a run, and a
read-only reviewer cannot run anything. Mutation testing that tries every mutant over
the whole suite weighs every line alike and costs a full run per mutant; the useful
mutations are few, and whoever reads the change knows which line a test guards. A suite
can be fully green and hide an inverted flag, an id dropped from a call to a vendor or a
guard removed, defects that breaking the guarded line on purpose finds and reading does
not. A run costs the tests of the files that import the changed one, minutes per
mutation where the tests spawn processes, and work runs in parallel: several worktrees on
one machine, each with its own review rounds, each round with its own runs.

## Decision

`tests` is an area of [`lntt check`](./lntt-command.md), the one the `tests` lens reads
([review agents](./review-agents.md)). A test is accepted when it fails for the right
reason, and sits at the lowest level where its assertion can; that is judged by reading,
and a mutation run by hand is the proof when reading leaves a doubt.

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
  - `focus`: `.only`, a new `.skip` or todo, a test with no assertion. A skip decided
    while the test runs, `t.skip('<reason>')` with a string or template literal that
    opens with text saying why (a provider's usage limit left the call with nothing to
    prove), is allowed: it shows as skipped, with its reason. A bare `t.skip()`, an empty reason, one that is not a
    literal or a template opening with a placeholder still fails.
  - `rules`: the lines that match a rule; a rule asserted by the suite is cited. A rule
    whose `anchor` names a record that is not there, or a heading the record does not
    have, fails. Headings resolve as GitHub's slugs do, over CommonMark's blocks: a
    heading is indented by up to three spaces, a repeated heading is numbered `-1`,
    `-2`, and a fence closes on a bare run of the same character at least as long as
    its opening, so fenced lines are no heading.
  - `touched` (needs `--base`): the lines the diff changes and the tests that run them,
    from the `coverage` of the test files that import the changed file, or from imports
    alone when a level has no `coverage`. A review round asks for no coverage
    (`coverage: false` in the options it passes) and gets the tests from imports alone,
    with `coverage not run` in the message; `lntt check tests touched` run by hand keeps
    coverage where a level has it. Coverage says which tests to run and which lines no
    test reaches; it is not an acceptance criterion. Coverage of the project belongs to
    a periodic check of the whole project (#311), not to a review round or a pull
    request.
  - `mutate <path:line> --text <on the line> --to <mutated>`, a tool run by hand: applies the mutation,
    runs the tests that import the file (a level's `repeat` times in a row; for a
    file that is not code and that no test imports, such as a `SKILL.md` a test reads
    as text, the test files whose text names the file's path or its last two
    segments (`review/SKILL.md`), or a directory of two segments or more of it, whole or
    by its last two (`skills/review`); the output says they were chosen by name), and
    reports killed (the failing test and its message, `PASS`), survived (`FAIL`), or
    `NOT RUN` when the path leaves the project, the text is not once on that line, the
    tests fail without the mutation, they outlast `timeoutSeconds`, or the file is one
    git ignores (the scratch does not have it). It takes the worktree's lock, the one a
    round of `lntt review` holds (see `review-agents.md`), and refuses to run while any
    other holder (a round, a reply, `allow`, another mutation) has it, so a mutation
    the author starts during a round is refused until the round ends; outside a git
    directory it cannot run (`lntt: error:`, exit 1, not a `NOT RUN`).
- **The mutation lives in a scratch git worktree** of the head, with the uncommitted
  files laid over it and the dependencies shared, and is removed when the run ends: the
  working tree is never written. A failure counts as killed only when the same tests
  pass without the mutation.
- **A review round runs no test.** It reads the static checks of `lntt check`, and the
  `tests` lens judges by reading. A test the reviewer suspects would still pass with
  the line wrong is a note that ends with ``mutate: `text` => `mutated` ``, the mutation
  for the author to run by hand; no finding is confirmed or refuted by a run. The brief
  asks for the mutations of the list that matter (a polarity flipped, an argument
  dropped, a guard or early return removed, the optimistic constant returned, the call
  removed), wiring before units.
- **A mutation is run by hand, never required.** The author runs `mutate` on a test they
  doubt, or on the mutation a note of the `tests` lens proposes; a killed mutant counts
  when the test that fails is the one that guards the line and its message names the
  defect, and a surviving one means the test does not exist, whatever the coverage
  says. The procedure is the shared skill `mutation-check`. Nothing in the process, the
  pull request body or `lntt check body` asks for a mutation.
- **The rule holds in every Lunette project.** It is decided here and reaches a project
  with `lntt`: `mutate`, the `tests` lens and the `mutation-check` skill. A project
  chooses its levels and the commands that run them, not whether the rule applies.
- **What stays with the model:** whether a test is at the lowest level that can fail for
  the right reason, whether a jsdom test drives a stub, an expected value copied from
  the output instead of the contract, and which mutations to propose.

## Consequences

### Positive

- A level mismatch, a `.only` or a forbidden pattern is found the same way every round,
  by a cheap check.
- "This test would still pass if the line broke" is a run with a named outcome, when
  the author runs it.
- A review round starts no test process: rounds in parallel worktrees do not load the
  machine with test runs, and a project whose tests spawn processes can be reviewed on
  the machine that runs them.
- The levels of a project (pelion's, wai's) fit one table, which also tells a new
  contributor where a test goes.

### Negative / accepted risks

- A project must write `tests.levels` with a `run` command before `mutate` works; the
  tests of a line are found from imports, and for a file that is not code from the
  path or directory a test names, so a test that reaches code only through a package
  name or a spawned process path that is not a string in the test is missed and the
  mutant may survive for want of a test that does run it. A directory of one segment
  (`docs`) is no name: it would select almost every test, and a survivor would claim
  coverage it does not have.
- A test that would survive a mutation is found by reading, or when the author runs
  the mutation a note proposes; nothing forces the run, and a note left unrun is a
  doubt the pull request carries.
- A mutation is proposed in a line whose text and mutated text hold no
  backtick: the reviewer names the others in words.
- An interrupted run (SIGINT, SIGTERM) leaves its scratch worktree registered under the
  system's temp folder; the working tree is untouched, and `git worktree prune` once
  the `lntt-mutate-*` folder is removed clears the registration.
- A mutation run costs the tests of the files that import the changed file. A timeout
  stops the shell that runs the command; a process it started may outlive it.
- A run-time `t.skip('<reason>')` passes `focus` whatever the condition that reaches it,
  so a test that skips on a condition always true is seen only as skipped in the report;
  the reason written beside the call is what a reviewer reads.
- Each scratch worktree copies the links of `node_modules`; a project whose tests need
  built output that is not committed fails without the mutation and is `NOT RUN`.

### When to deviate (revisit triggers)

- Mutations that notes propose and that survive when run are frequent, and notes go
  unrun: run them where the load does not fall on the author's machine, in the CI.
- Reviewers' proposals that survive are rarely real gaps: tighten the brief.

## Discarded directions

- **The rule as a per-project choice.** A green suite that hides a silent defect is a
  risk of every project, and the tools that apply the rule ship with `lntt` in all of
  them; a choice per project would leave the skill and the lens applying a rule the
  project's records do not state.
- **The rule in a template's testing record.** It would reach only the projects
  scaffolded from that template, and none that adopts `lntt` later; the rule governs the
  checks `lntt` runs, so it is filed with them.
- **A review round that runs the mutations the tests reviewer proposes.** One mutation
  runs every test file that imports the changed one, minutes each where the tests spawn
  processes; rounds in parallel worktrees, each running its own, saturated the machine
  that runs them.
- **Coverage for `touched` in a review round.** It runs every test file of a level with
  `coverage` on a scratch copy of the head, every round, to place lines that the imports
  already tie to their tests.
- **A mutation required for every test that guards a line,** reported in the pull
  request body. It runs tests a reading already accepts, on every change; which line a
  test guards is a judgement, and a count of mutations per test file would pass on a
  mutation of the wrong line and fail on a helper that guards nothing.
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
- **A `test-levels` guard in `@lntt/test-utils`**, an architecture test that every
  `.test` file opens an integration harness, as pelion's does. The `levels` check
  decides the same from `tests.levels`, with the harness per level in configuration
  instead of a regular expression in a spec, in every project that runs `lntt check`.
- **Coverage as an acceptance criterion.** A line run is not a line checked; coverage
  only names the tests to run.
- **A run-time skip reported as a diagnostic (`t.diagnostic` and `return`).** The test
  would end green while it proved nothing, which is what `focus` exists to stop; the
  reasoned `t.skip` keeps the skip visible in every reporter.
