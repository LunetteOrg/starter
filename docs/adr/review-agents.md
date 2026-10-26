---
status: accepted
date: 2026-10-17
tags: [review, agents, models, cost, lntt]
---

# Reviews by agents with no context, configured per project

## Context

A change is reviewed on the machine before its pull request is marked ready
([delivery](../process/delivery.md)). Done by the agent that wrote it, the review
shares the author's assumptions: it rereads the change with the model that produced
it, its tests confirm the design they came from, and it misses the inputs nobody
thought of. A reviewer started without that context finds them. Which agent reviews,
on which model, decides both what is found and what it costs, and left to each session
it is decided again every time, usually on the expensive model that wrote the code.

## Decision

The project configures who reviews (`delivery.review`); `lntt review` runs a round the
same way every time; the `review` skill keeps the judgement.

- **Lenses** are named in `delivery.review.reviewers`, each with the agents that review
  through it (`with`: `claude` or `opencode`, a model, an effort for claude) and the
  `paths` it covers. `decisions`, `code` and `tests` ship their briefs in
  `packages/lntt/agents/review/`; a project's own lens (a template's design or
  Storybook check) brings its `brief`, a file of the repository. A lens may list
  agents of several providers, so the blind spots of one model are not the review's.
- **What a script can check, a script checks.** A lens named after an area of
  `lntt check` (`decisions`, `tests`) gets `lntt check <area> --base <first commit read> --json`
  in its prompt, run before the reviewers, and its brief keeps only what needs
  judgement: violations, unrecorded decisions, the prose and the figures of the records
  the change touches. Each `FAIL` comes back as a warning at its line, since it breaks
  a recording rule; a contradiction with an accepted record stays a blocker. So the
  decisions lens runs on a cheap model, and a broken reference or a residue is found
  the same way every round. The `tests` lens gets `levels`, `focus`, `rules` and
  `touched` the same way, and keeps the level of each test, the stubs, the expected
  values and the choice of mutations
  ([test checks](./test-checks.md)).
- **A mutation a reviewer proposes is run, not argued.** The `tests` reviewer ends a
  finding line with ``mutate: `text` => `mutated` ``; between the reviewers and the
  verifiers `lntt review` runs each (`lntt check tests mutate`) on a scratch copy of
  the head. A surviving mutant confirms the finding and a killed one refutes it, with
  the run as the proof and no verifier asked; a run that could not happen leaves the
  finding to the verifiers.
- **Every finding is cited before it is verified:** `lntt check cite` reads its line in
  the working tree, which a round keeps clean at the head. A finding on a line past the
  end of its file is refuted there, by `lntt check cite`, and costs no verifier; the
  others take the line's text to their verifiers. A file that is not there goes to the
  verifiers: the change may be the one that deletes it.
- **Every reviewer starts with no context but its prompt** (the brief, the range, the
  files, the diff, the decision logs, the results of `lntt check` for its lens, on
  stdin) and **can only read**: `claude -p` with Read, Grep and Glob and no MCP server,
  `opencode run` with an inline agent that denies every tool and allows the read ones
  back. The tools are what makes it read-only, not
  the brief.
- **Adversarial verification:** every finding at a severity in `verify.severities`
  goes, at once, to every verifier in `verify.with` other than the agents that found it,
  each briefed to refute it (except a finding a mutation run decides, above); when those
  left are all optional, the required finders verify too, so a finding always has a
  required verifier. The verdict counts the
  verifiers that answered: all confirm, confirmed; all refute, refuted, kept out of the
  author's list with the proofs; otherwise undecided.
- **Rounds:** the first reads the branch from the base, later ones the commits after the
  last reviewed one, with fresh reviewers; findings still open go back to the verifiers
  on the new head, except notes and the warnings the ledger accepted open (below). The
  state stays in the worktree's git directory. A
  clean round (exit 0) has no blocker or warning left and no reviewer or verifier that
  failed; notes are reported, never blocking. Past `warningRounds` a round is clean with
  warnings left too (below). A finding is a bullet with its severity,
  an anchor (a line as `:12`, a range, a column or a list, each naming its first line,
  and an optional parenthesis after it) and its text (the action after a last separator,
  when there is one), wrapped over as many lines as the reviewer likes. A finding may
  name several places (`a.md:24-32 e :34-37`): the first is the anchor, checked and
  cited; the others stay in the text, unchecked. A line with no path-like token before
  the separator, and a `not checked: …` note, have no anchor. A reply with neither
  findings nor `no findings` counts as a failed reviewer. A finding line with no text
  does not drop the reply: the readable findings stand, the lines that cannot be read
  are reported in `partial` with the whole reply, and the round is not clean. A round
  with a failure or a `partial` lens does not move the reviewed commit; an optional
  agent never keeps it from moving, neither by failing nor by an unreadable line, which
  goes to `skipped` with the agent's readable findings standing. A failed reply
  keeps its whole text in `failed`. A fresh finding at the anchor of an open one joins it. A round runs
  on a branch (a detached HEAD is refused) whose head does not move until it ends.
- **The branch keeps a ledger of what it closed**, next to its state in the git
  directory: every finding the branch is done with, with its outcome. *Fixed*: one
  carried from an earlier round and refuted on a later head, with that head. *Refuted*:
  a fresh one refuted, with the proof (the verifiers', `lntt check cite`'s, a killed
  mutant's), or withdrawn by its reviewers, with the author's answer. *Accepted open*: a
  note, or a confirmed warning past `warningRounds`, with the reason. Each entry keeps
  what its line read when it was closed. Only a round with no failure and no `partial`
  lens adds to it, since the next round reads its range again; a ledger that cannot be
  read is said and started again. The reviewers get the entries on the files of the
  change and those with no anchor, each verifier the entries on its finding's file, and
  both are told that a finding a closed entry covers is reported again only when the
  code it cites changed. A fresh finding at the place of a refuted or accepted entry, on
  a line that reads the same and at a severity no higher, goes to the round's `closed`
  list with the entry it repeats and that entry's text: shown, never verified, never
  blocking. The match is by place, since a reviewer words the same finding differently
  every round, so the author reads each against the entry's text. A finding on a
  changed line, or at a higher severity, is a new finding.
- **A warning blocks only in the first `warningRounds` rounds:** later rounds find
  the edge cases of the fixes before them, and a round that must find nothing has no
  end on a change with many. From the next round only a blocker keeps a round from
  being clean (the round's `blocking` says which severities do); the warnings and notes
  left go in the pull request as open items. A confirmed warning enters the ledger as
  accepted open and is no longer carried; an undecided or unverified one stays carried,
  to be verified again, without blocking. A run with no new commit, which is not a round
  and does not count toward `maxRounds`, blocks as the round whose number it keeps. A
  `warningRounds` not below `maxRounds` leaves no round where only
  blockers block: the schema cannot compare two keys, so `lntt validate` says it as a
  warning (the file stays valid), and so do `lntt review --plan` and every round.
- **A branch takes at most `maxRounds` rounds:** later rounds find ever smaller things,
  and most of a pull request's time and cost went into them. Every round counts, one
  with a failure too. The round past the limit does not start; `lntt review` exits 3
  with what is still open (the findings not withdrawn and the failures of the last
  round), and the person decides: the pull request as it is, more rounds for that
  branch (`lntt review allow <rounds>`, kept in its state, the configuration
  unchanged), or an issue for what is open. A run with no new commit to read is not a
  round and is never stopped.
- **Load:** at most `perProvider` required agents of one provider run at once, and as
  many optional ones in a queue of their own, the others waiting their turn; a provider
  given dozens of sessions at once queues them until they time out. A slow optional
  agent never holds a required agent's turn. An agent marked `optional` (a free model)
  that fails is reported in `skipped` and does not fail the round; once the others have
  answered it has `optionalGraceMinutes` more, then it is stopped, so a round never
  waits on it.
- **Nothing runs forever:** each agent stops at `timeoutMinutes`, the whole round (or a
  reply) at `roundTimeoutMinutes` (the round fails and keeps what it gathered), an
  interrupt keeps the waiting agents from starting, and an agent that
  ignores SIGTERM gets SIGKILL five seconds later, or when `lntt review` exits. On macOS
  `caffeinate` keeps the machine awake while the round runs. One round or reply runs at
  a time in a worktree, under a lock that names its pid.
- **Progress is a contract:** stderr carries a line when each agent starts and ends
  (with its tokens), `failed` or `skipped` for one that did not answer, the agents still
  running every 30 seconds, `round N done` at the end, `error:` for a round that could
  not start and `limit:` for one past `maxRounds`. The `review` skill wakes on `failed`,
  `error:`, `limit:` and `round N done` only. The same goes as JSON events, one per
  line, to `<git dir>/lntt-review.progress`: the round with the pid of `lntt review`
  and the Claude Code session that started it (`CLAUDE_CODE_SESSION_ID`, or none),
  each phase with its total, each agent's start and end, a beat every 15 seconds, the
  end, the error, or the limit with the findings and failures still open. `lntt review
  allow` starts the file again with an `allow` event, so the limit leaves the band. The
  `lunette` plugin's band reads it and draws the round above the Claude Code prompt, with no Claude turn (a spinner, the
  phase as a bar, the tokens, the agents running), and tells a dead or silent run from a
  working one. Every session open in the checkout reads that file, so the band draws a
  round only in the session that started it; a round started outside a session (a
  terminal, an older `lntt`) shows in every session of the checkout. The plugin reads
  its session's id from Claude Code at every refresh (it changes on `/clear`); a session
  that cannot read it shows only rounds started outside a session. `/review-status` says when the round
  belongs to another session.
- **Seen where the person works:** under a Claude Code session in Orca, each agent is
  announced as a subagent of that session (Claude Code's `SubagentStart` and
  `SubagentStop`, sent through Orca's hook script, the start repeated every two seconds
  while the agent works, since Orca drops subagents when the parent's turn stops). This
  follows an internal Orca protocol: one small adapter, silent when any piece is
  missing. The agents themselves get none of the host's hook variables, so they never
  report as the session that started them.
- **A conversation inside a round:** `lntt review reply` resumes the sessions of the
  reviewers who found a finding with the author's answer; it closes when they all
  withdraw it. A disagreement that remains goes to the person.
- **The runner is its own module** (`src/headless.ts`): several agents and providers
  asked the same question at once, headless and read-only, for any practice that needs
  it; the review is its first user.

## Consequences

### Positive

- The model that reviews is chosen once per project, cheaper per lens where a checklist
  suffices, and the same for every session and person.
- The agent running the review decides only what needs judgement: fix, answer, ask.
- Findings that do not survive a refutation never reach the author.

### Negative / accepted risks

- Each reviewer is a process on the machine with the person's agent accounts; a round
  costs one call per agent and lens, plus one per verifier and finding.
- A failed round counts toward `maxRounds`: a reviewer that keeps failing can bring a
  branch to the limit with nothing found, and the person decides there.
- A round executes the project's own test commands (`tests.levels[].run` for the
  mutations a reviewer proposes, `coverage` for `touched`) on a scratch copy of the head,
  with the environment of `lntt` less `NODE_TEST*` variables: a project's tests run on
  the machine of the person who runs the round.
- The diff travels in the prompt: a very large change may not fit an agent's context.
- The adapters follow `claude -p` and `opencode run`, whose flags change; the tests pin
  the calls, a trial round against the real tools confirms them.
- opencode reports no cost: a round's `cost` covers only the agents that report it.
- The diff and the files a reviewer reads go to the provider of each configured agent,
  with that provider's terms on data (free models among them). Configuring an agent is
  the project's choice; `lntt review` names the destinations in `--plan` and in every
  round, and the schema says so where the agent is written.

### When to deviate (revisit triggers)

- An agent gains a read-only headless mode of its own (an equivalent of `--tools`):
  it joins `kind`.
- Another lens has checks that need no judgement (a lint script): they become an area
  of `lntt check` named after the lens, and its brief drops them.

## Discarded directions

- **A repeat of a closed finding matched by its wording.** A reviewer words the same
  finding differently every round, so a match on the text would almost never hold; the
  place and the line's text decide, and the author reads the entry's text beside it.

- **The harness's own subagents** (Claude Code's Agent tool, opencode's agents). Claude
  Code takes only a few model aliases there and opencode fixes the model in the agent's
  definition; neither reaches the other's providers, and each session would decide the
  mechanics again.
- **Agent definitions generated into `.claude/agents/` and `.opencode/agent/`.** A second
  way to start the same reviewers, which drifts from the one `lntt review` uses.
- **Read-only by instruction in the brief.** A reviewer with a tool that writes can use
  it; only the tools it is given hold.
- **One reviewer that also verifies.** It defends what it found; a refutation by an
  agent needs a fresh one, on another provider when one is listed.
