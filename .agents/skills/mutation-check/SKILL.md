---
name: mutation-check
description: Check by hand that a test fails for the right reason — break the line it guards with lntt check tests mutate and see which test fails and why. A tool, never required. Reads `tests.levels` from `.agents/config.*`. Use when the author doubts a test, when a note of the `tests` review lens proposes a mutation, and when asked whether a test would catch the code being wrong.
---
<!-- installed by lntt sync from @lntt/lntt: edit the skill in the package, not this stub -->

The guide of this skill comes with the project's `lntt`, at its version. Before acting,
load it and follow it:

```sh
pnpm exec lntt guide mutation-check
```
