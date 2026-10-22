---
name: coordinate
description: Coordinate a theme — several issues of one area that go at once, some independent and some stacked — from a coordinator worktree that writes no code and delegates each issue to a child worktree with lntt worktree start. Covers ordering the issues, the child's context file, the gate and the model per role, the mailbox (lntt ask, inbox, answer), following the children, and what a coordinator must never do. Use when started as a theme's coordinator, or when asked to run several issues in parallel under one coordinator.
---

# Coordinate a theme

A theme is several issues of one area. The coordinator holds the theme: the order, the
neighbours, the next brief from what the last child learned. It writes no code and its
context holds briefs, summaries and the merge order, never diffs. `lntt` does the mechanical
steps (`lntt worktree start`, `lntt ask`, `lntt inbox`, `lntt answer`; the `@lntt/lntt`
README lists their flags); this skill is the judgement around them. Never edit it to fit one
project.

The project's values are in `coordinator` of `.agents/config.*` (`lntt get coordinator`):
`gate` and `models`.

## 1. Starting the coordinator

The orchestrator (the person, or the session above) starts it:

```sh
lntt worktree start --coordinator --theme <slug> --issue <n> --issue <m> [--approve <n>]
```

The coordinator's brief (`agents/coordinator.md` of `@lntt/lntt`) lists the issues, the
children it may start at once (`--approve`), the model of each role and how to follow the
children. The worktree stays on its placeholder branch: no commit, no push, no pull request.

## 2. Order the theme

Read every issue (`gh issue view <n>`, with its comments) and the decisions it cites
before anything starts. Then decide:

- **Independent issues** start together, from the base branch.
- **A stacked issue** starts from its predecessor's branch (`--base`). When pull requests
  collect on a candidate branch, "the predecessor is merged" means merged into the open
  candidate, and the dependent child starts from the candidate; the child checks that its
  upstream is not the candidate and rebases if the candidate moves before Ready.
- **Two issues editing one file** are not stacked for that alone: different sections of one
  document merge in turn, and only a pull request that turns `CONFLICTING` is rebased.
- **Load, not a count, caps the parallelism.** Children that each start a database and end
  to end servers saturate a laptop: unlimited children for unit and documentation work, one
  heavy local CI at a time.

## 3. A child's context

A child does not see the coordinator's conversation. The file given to `--context` holds
what the issue and the repository do not: its neighbours and what each touches, the files or
sections it must leave alone, what it takes from a sibling and when, the order of the merges
and the rule for the branch that counts. Every path in it is found with `grep` before it is
written: a path rebuilt from memory or from a pull request title sends the child to the wrong
file. Say what an approval covers: a go-ahead to push and open the pull request is not one to
skip a review round.

## 4. Starting a child

```sh
lntt worktree start --theme <slug> --parent current --issue <n> --context <file> \
  --size <XS|S|M|L|XL> [--base <branch>] [--workflow]
```

- **The gate is the project's** (`coordinator.gate`). Under `propose`, a child that is not in
  the approved list is proposed to the orchestrator by the command itself, and nothing is
  created until the answer approves. Start nothing by another route (`git worktree add`, the
  host's own commands): they skip the gate and the models.
- **The model follows the Size** (`coordinator.models`), so the Size is the judgement:
  M or larger for anything that changes a public interface, infrastructure or a shared
  contract, whatever the issue says. Pass no `--model` unless the person asked for one.
- **`--workflow`** is for an issue of size M or larger: the child's brief then asks for a
  workflow in phases (readers, **one** writing agent, verification), at most 6 agents, never
  `isolation: 'worktree'`. The coordinator runs no workflow itself and never writes the
  harness's opt-in keyword anywhere: the flag is the switch.
- A start that reports failure may have succeeded: look at the host (the worktree, the
  branch, the agent's terminal) before starting it again.

## 5. Following the children

```sh
lntt inbox --as coordinator --theme <slug> --wait      # what they ask and report (returns at once while any message is unanswered: answer each one)
lntt answer <id> "<answer>"
lntt ask --to orchestrator "<questions>"               # waits for the person's answer
```

- **A child's report** is one line: the pull request link, its head SHA, its checks, its
  friction. The long description is for when it is asked.
- **Check on the pull request itself before saying a check passed or is pending**
  (`gh pr checks`, or the API): a check reported "without outcome" from memory has to be
  re-read before every merge.
- **Questions for the person go to the orchestrator, batched**: every open question in one
  message, each with a recommendation. While waiting, keep following the children.
- **A freeze** from the orchestrator ("STOP: no new children, no rebases, no Ready, no
  reports except a prompt waiting or something irreversible") holds until it is lifted in
  words. Reports shrink to one line per ready pull request.
- **On Orca**, follow a child with `terminal wait --for tui-idle` and then `terminal read`;
  idle is not done (an agent waiting on its own background agents is idle), and the child's
  card comment is the reliable state. Never resend on silence, and read the terminal before
  sending text: text typed under an open question becomes its answer.
- **A long wait is one background wait** with one notification, not repeated checks: every
  polling turn re-reads the whole context.
- **A watcher is light.** One read every couple of minutes (150 seconds worked), a line only
  when something changed, no heartbeat, no automatic restart: under memory pressure the host kills background shells
  of an idle session, and a heavy watcher is the first to go. A watcher that died is
  restarted by hand after looking at why.
- **A child runs `ci:local` in the foreground,** within the timeout `ci.local` sets, not as
  a background shell: the host kills the background shells of an idle session and the run
  dies with no result. Say so in the child's context.
- **On Orca** the CLI has no Sleep (the UI has one; `orca --help` shows what the installed
  version offers), and `terminal close` also deletes the records that resume the session:
  close a terminal only for good.

## 6. Merging and cleaning up

- **A merge is a person's call, every time**, with `--match-head-commit` on the head that
  was verified. A green check, a clean review or a merge mentioned in passing is not a go.
- Re-read `mergeStateStatus` before each merge in a row; rebase only a pull request that
  became `CONFLICTING`, and run its local CI again.
- **Remove a child's worktree only when its pull request is `MERGED`**, `git status
  --porcelain` is empty and `@{upstream}..HEAD` is empty. Stop its containers by label
  first, never pass `--force`, keep the branches. A cleanup script that calls `docker rm`
  can be refused by the host's safety check: run `docker ps` first and run the script only
  when containers exist.
- The theme outlives its pull requests: the coordinator stays while the theme has open
  issues, and is archived when the last child has merged.

## 7. What a coordinator brief must say

The brief `lntt worktree start --coordinator` renders already says: write no code; the
issues; the gate and who is approved; the model of each role; `--context`, `--size`,
`--workflow` and `--base` for a child; the mailbox; `orca` by absolute path; never merge or
mark ready; return the state of the theme and the friction. Also say:

- A path in a brief is found by `grep`, not rebuilt.
- An approval names what it covers.
- Reports are one line per ready pull request; decisions are batched, with recommendations.
- Checks are read from the pull request before they are reported.
- The queue rule says which branch counts.
- A status comment names the ref its line numbers were read on.
- A pipe on `git commit` hides a commitlint rejection: never filter a commit's output.

- **Briefs and theme sections live in an untracked directory of the coordinator's worktree.**
  Pass them with `--context <file>`, which needs no shell quoting of backticks or `$`. Do not
  `cd` into that directory: the shell keeps the working directory.
- **On Orca the child's worktree does not exist when its brief is written:** the brief says
  "the worktree this session starts in", not a path.
- **A stacked child's base must exist before the child starts.** The sibling pushes the base
  with the interface the child needs and signals it with a message; the go for the first wave
  does not cover the stacked child. The stacked child opens its draft pull request against
  its base branch and retargets it after the base merges.
- **Questions for the person go through the mailbox** (`lntt ask --to orchestrator`, polled
  every 20 seconds), never to the tab. Every brief says so.
- **A message that needs no answer still gets an `.answer.md`** (a line such as "noted"),
  or the watcher on the inbox reports it again.
- **Reading a child's terminal:** `orca terminal read --json` returns every screen cell, tens
  of KB per read. Reduce it to the text or the last lines before it enters the context.
- **A round cap for `lntt review` is set by the coordinator in the child's context.** A
  review that keeps finding small notes after several rounds (one child ran 7) stops where the
  coordinator said it stops; without a cap, the child's judgement is the only brake.
- **Reports to the person go to the orchestrator's mailbox, not only the tab:** a short status
  when asked, and the final report when the last draft pull request is open.
- **A candidate automation retargets draft pull requests** after they open (from the base
  branch to the open candidate, and a stacked one twice). Read each pull request's base with
  `gh` before listing the merge order.
- **A review stops where the coordinator says.** Name the rule in the child's context: a round
  cap, or stop when only notes and findings outside the issue remain, and list those in the
  pull request. A round that is not empty at the cap is reported as such.
- **Ask each child for its review cost in one line:** rounds, tokens and USD. Agents report
  cost differently (tokens, USD, nothing).
- **A skipped optional verifier** (a free model that timed out or was rate limited) is
  reported in the round's `skipped`; say in the child's context that a round with skipped
  verifiers still counts, and that the confirmed findings are what block.
- **What worked:** a sibling signals a stacked child by message (the base is pushed and its
  interface stable) and the stacked child starts from that branch; the theme section names the
  files shared between siblings; a child puts an open decision to the coordinator through the
  mailbox with its criteria.
