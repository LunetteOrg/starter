---
name: mutation-check
description: Check that a test falls for the right reason before it is accepted — break the line it guards with lntt check tests mutate, see which test fails and why, and report the mutation in the pull request body. Reads `tests.levels` from `.agents/config.*`. Use after writing or changing a test that guards a line, before opening a pull request that adds tests, and when asked whether a test would catch the code being wrong.
---
<!-- installed by lntt sync from @lntt/lntt: edit the skill in the package, not this stub -->

The guide of this skill comes with the project's `lntt`, at its version. Before acting,
load it and follow it:

```sh
pnpm exec lntt guide mutation-check
```
