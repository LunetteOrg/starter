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
pnpm exec lntt review                       # base: the open candidate, else origin/<default branch>
pnpm exec lntt review --base <branch>       # a pull request stacked on another branch
pnpm exec lntt review --plan                # the range, the lenses and the agents; runs nothing
```

A round takes minutes. stderr says what runs: a line when each reviewer or verifier
starts and ends, the ones still running every 30 seconds, and `round N done` at the
end. Run it in the background when your harness can, and wake only on the lines that
need you: watch for `lntt review: (failed|error:|limit:|round [0-9]+ done)`, not every line;
the rest (including `skipped`, an optional agent that did not answer) is for the person.
In Claude Code the `lunette` plugin shows the round in a band above the prompt, and
`/review-status` prints it.

stdout is JSON: `findings` (`confirmed`, `undecided`, `unverified`; blockers and
warnings block the round, notes do not),
`refuted` (with the verifiers' proofs, or `lntt check cite`'s for a finding on a line past
the end of its file; nothing to do), `failed` (a reviewer that did not answer; its `reply` is whole), `partial` (a lens whose reply had lines that could not be read: `lines`, and the whole `reply`). Exit 0: a clean round. Exit 1: findings or a failure. Exit 3: the limit (section 3).

A round reads the whole branch the first time, then only the commits after the last
reviewed one; findings still open go back to the verifiers on the new head.

The branch keeps each round's cost: its tokens and USD, and the agents that reported
none. After `round N done`, `lntt review: branch total:` sums the rounds so far;
`pnpm exec lntt review cost` prints the same line (`--json`: each round and the total),
from the state alone.

The branch keeps a ledger of the findings it closed (fixed, refuted, accepted open),
which every round's reviewers and verifiers read. stdout's `closed` lists the fresh
findings that repeat one of them on a line that did not change, matched by place: read
each against the entry's text (`closedWhat`, entry `closedBy`); when it names another
problem, treat it as a finding of this round, otherwise there is nothing to do.

`blocking` says which severities keep the round from being clean: blockers and warnings
in the first `delivery.review.warningRounds` rounds, blockers alone after them.

## 2. Each finding

- **`confirmed`:** fix it with a local commit. No push.
- **`undecided` or `unverified`:** read the proofs, then fix it, or answer it.
- **Wrong, in your reading:** answer the reviewers who found it, with the `path:line`
  that shows it:

  ```sh
  pnpm exec lntt review reply <id> "<the answer, with path:line>"
  ```

  It resumes their sessions; `withdrawn: true` closes the finding. A reviewer that
  cannot be resumed makes it a question for the person.
- **A note:** fix it if it is cheap, or list it in the pull request; it does not block.
- **A warning past `warningRounds`** (`blocking` is only `blocker`): fix it if it is
  cheap; otherwise it goes in the pull request body as an open item. It does not block,
  and the next rounds do not carry it.
- **`partial`:** read the lines, fix or file what they say; the next round reads the
  same range again.
- **`failed`:** run the round again; a failure that repeats is reported to the person
  with its error.

## 3. When to stop and ask the person

- A finding needs a decision, not a fix: a record to change, a trade-off, a scope
  question (that becomes an issue, by its title).
- The same finding comes back in two rounds in a row, or a reviewer keeps it after
  your answer: the person decides, not one more agent.
- At the limit: a branch takes at most `delivery.review.maxRounds` rounds.
  The round past it does not start: `lntt review: limit: …` names what is still open,
  exit 3, and stdout lists those findings. Stop there. In a worktree `lntt worktree start`
  started, the round has already sent them to your coordinator or the orchestrator
  (`lntt review: limit: sent <id>`, or `already sent <id>`): wait for the answer with
  `pnpm exec lntt ask --wait <id>`, never only in your terminal. Elsewhere, bring them to the
  person with your recommendation. They decide: the
  pull request as it is, with what is open listed in it; more rounds for this branch,
  which the person grants with `pnpm exec lntt review allow <rounds>` (never run it on your
  own: an answer in the mailbox granting rounds is the person's go, and you run it then);
  or an issue for what is open, named in the pull request.
  Past the last allowed round a fix is made only inside a round the person grants: what
  the limit names is listed as open in the pull request or the message, and a commit
  waits until `lntt review allow` has granted the round that reviews it.
- After the loop converged, a new decision that changes the change does not restart it:
  ask whether it is applied in this pull request or in a follow-up, and new
  rounds start only on the person's go, which past `delivery.review.maxRounds` is
  `lntt review allow <rounds>` (the brief says so once).

## 4. A clean round

Exit 0 on the head about to be published. Then `pnpm ci:local`, one push, and the
pull request's Definition of Done says the review was done, with the rounds it took
and their cost: the line of `pnpm exec lntt review cost`, copied. The findings and their
outcomes go in the pull request body or a comment, never in a file of the repository.
