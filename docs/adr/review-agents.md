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
  `lntt check` (`decisions`) gets `lntt check <area> --base <first commit read> --json`
  in its prompt, run before the reviewers, and its brief keeps only what needs
  judgement: violations, unrecorded decisions, the prose and the figures of the records
  the change touches. Each `FAIL` comes back as a warning at its line, since it breaks
  a recording rule; a contradiction with an accepted record stays a blocker. So the
  decisions lens runs on a cheap model, and a broken reference or a residue is found
  the same way every round.
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
  each briefed to refute it; when those left are all optional, the required finders
  verify too, so a finding always has a required verifier. The verdict counts the
  verifiers that answered: all confirm, confirmed; all refute, refuted, kept out of the
  author's list with the proofs; otherwise undecided.
- **Rounds:** the first reads the branch from the base, later ones the commits after the
  last reviewed one, with fresh reviewers; findings still open go back to the verifiers
  on the new head, notes excepted. The state stays in the worktree's git directory. A
  clean round (exit 0) has no blocker or warning left and no reviewer or verifier that
  failed; notes are reported, never blocking. A finding is a bullet with its severity,
  an anchor (a line as `:12`, a range, a column or a list, each naming its first line,
  and an optional parenthesis after it) and its text (the action after a last separator,
  when there is one), wrapped over as many lines as the reviewer likes; a reply with a
  finding line that has no anchor or no text, or with neither findings nor `no
  findings`, counts as a failed reviewer, and a round with a failure does not move the
  reviewed commit. A fresh finding at the anchor of an open one joins it. A round runs
  on a branch (a detached HEAD is refused) whose head does not move until it ends.
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
  running every 30 seconds, `round N done` at the end and `error:` for a round that could
  not start. The `review` skill wakes on `failed`, `error:` and `round N done` only. The
  same goes as JSON events, one per line, to `<git dir>/lntt-review.progress`: the round
  with the pid of `lntt review`, each phase with its total, each agent's start and end,
  a beat every 15 seconds, the end or the error. The `lunette` plugin's band reads it
  and draws the round above the Claude Code prompt, with no Claude turn (a spinner, the
  phase as a bar, the tokens, the agents running), and tells a dead or silent run from a
  working one.
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
- Another lens has checks that need no judgement (a lint script, a mutation run): they
  become an area of `lntt check` named after the lens, and its brief drops them.

## Discarded directions

- **The harness's own subagents** (Claude Code's Agent tool, opencode's agents). Claude
  Code takes only a few model aliases there and opencode fixes the model in the agent's
  definition; neither reaches the other's providers, and each session would decide the
  mechanics again.
- **Agent definitions generated into `.claude/agents/` and `.opencode/agent/`.** A second
  way to start the same reviewers, which drifts from the one `lntt review` uses.
- **Read-only by instruction in the brief.** A reviewer with a tool that writes can use
  it; only the tools it is given hold.
- **One reviewer that also verifies.** It defends what it found; a refutation needs a
  fresh agent, on another provider when one is listed.
