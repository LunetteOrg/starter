---
name: github-board
description: Open, write, triage, prioritize, organize and link GitHub issues on the project's GitHub Project (v2), as the `board` section of `.agents/config.*` describes it — the issue types and which are parents, the fields and their options, sub-issues, iterations, milestones, blocked-by dependencies, track labels — with every id resolved at runtime. Required before any `gh issue create`, a single follow-up or a bug spotted mid-PR included: an issue with no type and no fields is invisible to every view. Use when asked to open, file, retitle, triage, prioritize, organize or link issues, to set up or fix the board, or to wire dependencies. `plan-round` produces a plan; this skill lands it on the board.
---
<!-- installed by lntt sync from @lntt/lntt: edit the skill in the package, not this stub -->

The guide of this skill comes with the project's `lntt`, at its version. Before acting,
load it and follow it:

```sh
pnpm exec lntt guide github-board
```
