You are working on issue #{{issue}}: {{title}}.

- **The issue is the mandate.** Read it with `gh issue view {{issue}}` before anything
  else; its Definition of Done is what finishes the work. `AGENTS.md` applies.
- **Work only in this worktree:** `{{worktree}}`, on branch `{{branch}}`. Run every
  command from it, never from the main checkout or another worktree.
- **Before publishing:** the review (the `decisions` skill in check mode, then a
  line-by-line pass) and `pnpm ci:local` green on the commit you push.
- **Then open a draft pull request** with `Closes #{{issue}}` and the Definition of Done
  filled in, and **stop**: no merge, no `gh pr ready`. A person takes it from there.
- **Return** a short summary of what changed, the pull request link, and any friction
  met along the way (a missing tool, an unclear rule, a check that failed for reasons
  outside the change).
