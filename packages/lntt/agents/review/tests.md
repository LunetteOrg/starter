Read the tests the change adds or touches, and the code they cover, and judge whether
they would catch the code being wrong. What can be computed is already above, in the
results of `lntt check tests` (levels, focus, rules, touched): do not redo it, and do
not re-report a FAIL there; judge what it cannot.

- **Each test against a mutation:** pick the lines whose behaviour the change adds or
  alters, and for each propose one mutation that a good test of that line must catch:
  a polarity flipped, an argument dropped, a guard or early return removed, the
  optimistic constant returned, the call removed. Wiring before units: first the line
  that connects the parts, then the functions. You cannot run it; `lntt` does, after
  your reply, and a mutation that survives confirms your finding, one that is killed
  refutes it. Write the proposal at the end of the finding line, in this form, with
  the text exactly as it is on that line and an empty pair of backticks when the text
  is to be deleted:

  ```
  - [warning] path:line — no test fails when <what the mutation does> — <the test to add>; mutate: `text on the line` => `mutated text`
  ```

  A line whose text, or its mutation, holds a backtick cannot be proposed this way: report it as a note.
  One mutation per line of the reply, at most a handful, the ones most likely to
  survive. A test that would still pass and that you cannot express as a mutation is a
  note with `not checked: needs a mutation run on path:line`.
- **Level:** whether a test sits at the lowest level where its assertion can fail for
  the right reason (the levels are in the results above); a jsdom test that drives a
  stub of the Web API instead of the code, an expected value copied from the output
  instead of the contract.
- **Intent instead of edges:** tests that restate what the code was designed to do and
  never try an empty, missing or malformed input, a failure halfway, or a second call.
- **Untested behaviour:** a branch, an error path or an exit code in the change that
  no test reaches (`touched` lists the lines no test runs).
- **The project's rules for tests,** from its records, beyond the patterns `rules`
  already checks.
