---
name: mutation-check
description: Check by hand that a test fails for the right reason — break the line it guards with lntt check tests mutate and see which test fails and why. A tool, never required. Reads `tests.levels` from `.agents/config.*`. Use when the author doubts a test, when a note of the `tests` review lens proposes a mutation, and when asked whether a test would catch the code being wrong.
---

# Mutation check

A test fails for the right reason, not only passes. Whether it does is read first, by
the author and by the `tests` lens of `lntt review`, which runs no test; a mutation is
the proof when reading leaves a doubt. This skill is a tool the author runs by hand,
never required: on a test the author doubts, or on a note of the `tests` lens that ends
with ``mutate: `text` => `mutated` ``. Every mutation runs the test files you name, one at a time: pick the few mutations that
matter. Never edit it to fit one project.

## 1. Anchor and read

- Work from the worktree root, with the change saved: a mutation runs on the head with
  the uncommitted files laid over it.
- `pnpm exec lntt get tests.levels`. **No `tests.levels`:**
  stop and propose them (the test files you can see by level, lowest first, and the
  command that runs each); `mutate` has nothing to run without a level's `run`.

## 2. Pick the lines

For each test in doubt, name the line it guards: the line whose
behaviour would be wrong if the test were missing. Wiring before units: the line that
decides which value goes to which caller, which id reaches which client, whether a call
happens at all, comes before the functions it connects. A test that guards no line you
can name is a test of nothing; say so instead of mutating.

Look first for the silent defect: the mutation that throws nothing and breaks nothing
visible (a flag inverted, an id lost, an event not sent). A crash is found anyway.

## 3. Mutate

One mutation per line, from these, the one most likely to survive first:

- a polarity flipped (`if (consent)` → `if (!consent)`, `>` → `<=`);
- an argument dropped from a call, a call to a vendor above all;
- a guard or early return removed;
- the optimistic constant returned (`return true`, `return []`);
- the call removed.

```sh
pnpm exec lntt check tests mutate <path:line> --text='<exactly as on the line>' --to='<mutated>' --test <test file>
```

`--test` names the test file that guards the line, which you have just written or read;
give it once for each file to run (at least one). A survivor lists the files that ran.
Write `--text=...` with the `=` when the text starts with `-`, and `--to=''` to delete
it. A text that holds a single quote goes between double quotes, with `$`, `` ` `` and
`\` escaped. The run happens in a scratch git worktree and is removed when it ends: nothing is
restored by hand, and the working tree is never written.

## 4. Read the outcome

- **`PASS`, killed:** read the failing test and its message. It is accepted only when
  the test that fails is the one that guards the line and its message names the defect
  the mutation made. A failure elsewhere (a type error, a crash in a helper, another
  test) is no proof for this test.
- **`FAIL`, survived:** the test does not exist, whatever the coverage says. Make it
  assert the effect the line has, run the mutation again, and repeat until it is killed.
  A test that asserts the current output instead of the contract (an expected value
  copied from a run) is rewritten from the contract.
- **`NOT RUN`:** the reason is on the line (the text not once on that line, the tests
  failing or hanging without the mutation, a `--test` that is not a file of the project or sits in no level, a level whose `run` has
  no `{files}`, a path
  outside the project or git-ignored).
  Fix the call or the suite, or report the line as not checked, with the reason.

## 5. Report

A mutation run may be cited where it settles something: in the answer to the review
note that proposed it, or in the pull request body, one line each. Nothing in the
process or in `lntt check body` asks for one.

```
- path/to/file.ts:42 `if (consent)` => `if (!consent)`: killed by "sends no event without consent"
```
