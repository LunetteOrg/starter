Read the tests the change adds or touches, and the code they cover, and judge whether
they would catch the code being wrong.

- **Each test against a mutation:** break, in your head, the line the test claims to
  guard (flip a condition, drop a step, return early). A test that would still pass is a
  warning naming that line. When only a run would tell, write
  `not checked: needs a mutation run on path:line`.
- **Intent instead of edges:** tests that restate what the code was designed to do and
  never try an empty, missing or malformed input, a failure halfway, or a second call.
- **Untested behaviour:** a branch, an error path or an exit code in the change that
  no test reaches.
- **The project's rules for tests,** from its records (mocks, fixtures, databases,
  timeouts): a test that breaks them.
