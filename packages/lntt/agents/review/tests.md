Read the tests the change adds or touches, and the code they cover, and judge whether
they would catch the code being wrong. What can be computed is already above, in the
results of `lntt check tests` (levels, focus, rules, touched): do not redo it, and do
not re-report a FAIL there; judge what it cannot.

- **Each test against a mutation:** pick the lines whose behaviour the change adds or
  alters, and for each ask which mutation a good test of that line must catch: a
  polarity flipped, an argument dropped, a guard or early return removed, the
  optimistic constant returned, the call removed. Wiring before units: first the line
  that connects the parts, then the functions. Judge by reading the tests: nothing runs
  them during the review. A test you suspect would still pass with the line wrong is a
  note that ends with the mutation, for the author to run by hand (`lntt check tests
  mutate`), with the text exactly as it is on that line and an empty pair of backticks
  when the text is to be deleted:

  ```
  - [note] path:line — no test fails when <what the mutation does> — <the test to add>; mutate: `text on the line` => `mutated text`
  ```

  A path that holds a space goes between backticks, as in every finding: `` `docs/my notes.md:12` ``.
  A line whose text, or its mutation, holds a backtick is a note without the mutation,
  which names it in words. One mutation per line of the reply, at most a handful, the
  ones most likely to survive.
- **Level:** whether a test sits at the lowest level where its assertion can fail for
  the right reason (the levels are in the results above); a jsdom test that drives a
  stub of the Web API instead of the code, an expected value copied from the output
  instead of the contract.
- **Intent instead of edges:** tests that restate what the code was designed to do and
  never try an empty, missing or malformed input, a failure halfway, or a second call.
- **Untested behaviour:** a branch, an error path or an exit code in the change that
  no test reaches (`touched` lists, for each changed file, the tests that import it, or
  that none does).
- **The project's rules for tests,** from its records, beyond the patterns `rules`
  already checks.
