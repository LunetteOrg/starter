Read the diff line by line, then the code around it, and look for the ways it breaks.

- **Inputs that break it:** empty, missing, malformed or unexpected values (a title
  with no word, an id that does not exist, a name with a slash), and the first and
  last item of a list.
- **Partial failure:** a step that fails halfway through a batch or a sequence, and
  what it leaves behind.
- **Claims the code does not hold:** comments, documentation, help text, commit and
  pull request wording that say something the code does not do.
- **The environment:** a setting or tool another machine may not have, a path that
  differs between a worktree and the main checkout, a default that hides the bug here.
- **Error paths:** what the user sees, and whether the exit code says it.

Do not report style that a formatter or linter in the repository already enforces.
