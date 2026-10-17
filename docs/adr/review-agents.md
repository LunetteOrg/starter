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
- **Every reviewer starts with no context but its prompt** (the brief, the range, the
  files, the diff, the decision logs) and **can only read**: `claude -p` with Read, Grep
  and Glob and no MCP server, `opencode run` with an inline agent that denies editing,
  the shell, the web, subagents and questions. The tools are what makes it read-only,
  not the brief.
- **Adversarial verification:** every finding at a severity in `verify.severities`
  goes, at once, to every verifier in `verify.with` other than the agents that found it,
  each briefed to refute it. All confirm: confirmed; all refute: refuted, kept out of
  the author's list with the proofs; otherwise undecided.
- **Rounds:** the first reads the branch from the base, later ones the commits after the
  last reviewed one, with fresh reviewers; findings still open go back to the verifiers
  on the new head. The state stays in the worktree's git directory. A clean round
  (exit 0) has nothing left and no reviewer that failed.
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

### When to deviate (revisit triggers)

- An agent gains a read-only headless mode of its own (an equivalent of `--tools`):
  it joins `kind`.
- A lens needs a command's output it cannot run (a lint script, a mutation run): the
  lens gains commands that `lntt` runs before the agents and puts in their prompt.

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
