---
name: review
description: Review a change before its pull request is marked ready, with lntt review. Reviewers with no context of the conversation (the decisions, code and tests lenses, and any lens the project adds) run on the agents and models the project configures, their blockers and warnings are checked by verifiers briefed to refute them, and the loop runs until a round finds nothing. Use for every code review and pull request review, on your own change or someone else's.
---

# Review

`lntt review` does every mechanical step of a round: what to read, which reviewers,
on which agents and models (`delivery.review`), the adversarial check, the merged
list. This skill is the judgement around it. Never edit it to fit one project.

## 1. A round

From the worktree of the change, with every change committed:

```sh
lntt review                       # or: pnpm exec lntt review
lntt review --base <branch>       # a pull request stacked on another branch
lntt review --plan                # the range, the lenses and the agents; runs nothing
```

A round takes minutes. stderr says what runs: a line when each reviewer or verifier
starts and ends, the ones still running every 30 seconds, and `round N done` at the
end. Run it in the background when your harness can, and wake only on the lines that
need you: watch for `lntt review: (failed|error:|round [0-9]+ done)`, not every line;
the rest (including `skipped`, an optional agent that did not answer) is for the person.
In Claude Code the `lunette` plugin shows the round in a band above the prompt, and
`/review-status` prints it.

stdout is JSON: `findings` (`confirmed`, `undecided`, `unverified`; blockers and
warnings block the round, notes do not),
`refuted` (with the verifiers' proofs, or `lntt check cite`'s for a finding on a line
that does not exist; nothing to do), `failed` (a reviewer that did not answer). Exit 0: a clean round. Exit 1: findings or a failure.

A round reads the whole branch the first time, then only the commits after the last
reviewed one; findings still open go back to the verifiers on the new head.

## 2. Each finding

- **`confirmed`:** fix it with a local commit. No push.
- **`undecided` or `unverified`:** read the proofs, then fix it, or answer it.
- **Wrong, in your reading:** answer the reviewers who found it, with the `path:line`
  that shows it:

  ```sh
  lntt review reply <id> "<the answer, with path:line>"
  ```

  It resumes their sessions; `withdrawn: true` closes the finding. A reviewer that
  cannot be resumed makes it a question for the person.
- **A note:** fix it if it is cheap, or list it in the pull request; it does not block.
- **`failed`:** run the round again; a failure that repeats is reported to the person
  with its error.

## 3. When to stop and ask the person

- A finding needs a decision, not a fix: a record to change, a trade-off, a scope
  question (that becomes an issue, by its title).
- The same finding comes back in two rounds in a row, or a reviewer keeps it after
  your answer: the person decides, not one more agent.
- Rounds keep finding new problems after three rounds on the delta.

## 4. A clean round

Exit 0 on the head about to be published. Then `pnpm ci:local`, one push, and the
pull request's Definition of Done says the review was done, with the rounds it took
and their cost (`cost`, when the agents report it). The findings and their outcomes go
in the pull request body or a comment, never in a file of the repository.
