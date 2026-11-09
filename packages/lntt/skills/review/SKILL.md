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

stdout is a summary: one line of outcome, then a line per thing to act on, the open
findings blocking first, each with its id, severity, verdict, `path:line` and sentence,
then the failed reviewers, the lenses read in part and the repeated findings. Exit 0: a
clean round. Exit 1: findings or a failure. Exit 3: the limit (section 3).

The whole result stays in the state, and the details are read with
`pnpm exec lntt review status --query` (below): `.state.findings`, one list, each with a
`verdict` (`confirmed`, `undecided`, `unverified`; `withdrawn` after a reply; blockers and
warnings block the round, notes do not), `.state.refuted` (with the verifiers' proofs, or
`lntt check cite`'s for a finding on a line past the end of its file; nothing to do),
`.state.failed` (a reviewer that did not answer; its `reply` is whole), `.state.partial`
(a lens whose reply had lines that could not be read: `lines`, and the whole `reply`).

A round reads the whole branch the first time, then only the commits after the last
reviewed one; findings still open go back to the verifiers on the new head.

The branch keeps each round's cost: its tokens and USD, and the agents that reported
none. After `round N done`, `lntt review: branch total:` sums the rounds so far;
`pnpm exec lntt review cost` prints the same line (`--json`: each round and the total;
`--query`: a part of it),
from the state alone.

The branch keeps a ledger of the findings it closed (fixed, refuted, accepted open),
which every round's reviewers and verifiers read. The summary's `repeats` lines, and
`.state.repeated` in the state, are the fresh findings that repeat one of them on a line
that did not change, matched by place: read each against the entry's text (`closedWhat`,
entry `closedBy`); when it names another problem, treat it as a finding of this round,
otherwise there is nothing to do.

`.state.blocking` says which severities keep the round from being clean: blockers and warnings
in the first `delivery.review.warningRounds` rounds, blockers alone after them.

### Reading the state

The state between rounds is read only with `lntt review status`, never by opening
its files: they are one per branch, in a place the operator or the project may have moved
(`review.stateDir`, `delivery.review.stateDir`), shared by every worktree of the clone.

```sh
pnpm exec lntt review status            # each level as its count, the outcome, one line per thing to act on
pnpm exec lntt review status --json     # the whole state
pnpm exec lntt review status --query '.state.findings[] | select(.id=="f12")'
pnpm exec lntt review status --query '.state.rounds[1:3][] | {round,usd}'
pnpm exec lntt review status --query '.state.repeated[] | {id,closedBy,closedWhat}'
```

The default names what is there (`findings: 14 (3 open)`, `rounds: 4`); ask only for the
part you need. `--query` takes a jq expression on the `--json` document: strings raw and
the rest compact, one per line, or JSON values one per line with `--json` too. A jq
failure (an expression that does not compile, a failure while running) exits 2, with its
message on stderr and nothing on stdout; with no round on this branch, a failure while
running (`.state.open[]`) exits 4.

`--json`: `branch`, `running` (the pid of a round in progress), `state` (`round`,
`limit`, `reviewed`, `clean`, `atLimit`, `blocking`, `scope`, `lenses`, `open` (`findings` not withdrawn),
`replied`, `closed` (the ledger), `failed`, `partial`, `skipped`, `tokens`, `cost`,
`findings` (the last round's, every verdict), `refuted`, `repeated`, `rounds` (each
round's cost)). Exit 0: this branch's last round
is clean. 1: something to act on. 3: at the limit. 4: no round on this branch.
`pnpm exec lntt review status --clear` removes the current branch's state once it is merged
(refused while a round runs), or a state that cannot be read; `pnpm exec lntt review status
--prune` removes those of branches that are gone (`--dry-run` lists them).

## 2. Each finding

- **`verdict: confirmed`:** fix it with a local commit. No push.
- **`verdict: undecided` or `unverified`:** read the proofs, then fix it, or answer it.
- **Wrong, in your reading:** answer the reviewers who found it, with the `path:line`
  that shows it:

  ```sh
  pnpm exec lntt review reply <id> "<the answer, with path:line>"
  ```

  It resumes their sessions; `withdrawn: true` closes the finding (its `verdict`
  becomes `withdrawn`). A reviewer that
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
  exit 3, and stdout is the summary of the last round. Stop there. In a worktree `lntt worktree start`
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
