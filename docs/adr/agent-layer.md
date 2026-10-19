---
status: accepted
date: 2026-10-13
tags: [agents, skills, configuration, operator, templates]
---

# The agent layer

## Context

Every Lunette project works with coding agents through skills, instructions and a
handful of values: the GitHub project, the CI provider, the decision logs, the
language records are written in. Projects scaffolded from the same template grow the
same skills, and those skills drift apart for one reason: the project's values are
written inside them. A skill that names its project's board fields cannot be installed
anywhere else, and a fix made upstream cannot reach a project whose copy was edited.

The agent also needs to know who it is talking to: someone who wants every git step
explained, or a developer who wants none. That is personal, it must never be
committed, and it has to reach every worktree, since agents work in worktrees and git
shares no untracked file between them.

## Decision

### An installed skill is never edited

Skills hold procedure. Everything particular to a project lives outside them, in two
places a skill reads:

- **Values** in `.agents/config.jsonc` or `.agents/config.yml` at the repository root
  (one of the two), validated by `packages/lntt/schema/config.schema.json`.
  Sections are named after fixed process areas (`recording`, `board`, `ci`,
  `delivery`, `cycle`, `spaces`, `team`, `local`); a section is added when a skill
  needs it. A short reason for a value is a comment next to it.
- **Prose** in `docs/process/<area>.md`: the mechanisms and longer reasons a value
  cannot express. Kept apart from technical decisions; it cites configuration keys and
  never repeats their values.

Scripts and skills read the configuration through `@lntt/lntt` (`lntt get <key>`),
never with `jq` or `JSON.parse`: the file has comments, and writes must keep them. A skill that finds its section missing stops and proposes it;
it never guesses.

### Operator context is personal and found from any worktree

The operator profile has its own schema (`packages/lntt/schema/operator.schema.json`:
name, handle, role, language, confidence per topic, accounts, workspace with the
preferred viewers in order) and is read,
in merge order, from:

1. `~/.agents/operator.{jsonc,yml}`, for every project;
2. `<main checkout>/.agents/local/operator.{jsonc,yml}`, found from any worktree
   through `git rev-parse --git-common-dir`;
3. otherwise `~/.agents/projects/<org>/<repo>/operator.{jsonc,yml}`, for a checkout
   that has none (a fresh clone, a cloud session).

The project profile wins key by key; with no profile the speaker is a developer.
`.agents/local/` is git-ignored in this repo and in every template. Free notes sit
next to the profile (`.agents/local/operator.md`, `~/.agents/AGENTS.md`); what other
people need (handle, role, ownership) goes in the tracked `team` section instead.

`.agents/` is the directory agents already share: `npx skills` and the Agent Skills
guidance use `.agents/skills/` and `~/.agents/skills/` across clients.

### What a number means is shown on screen, not asked of the agent

In Claude Code the `lunette` plugin shows, beside the first `#N` of each message, the
title of that issue or pull request, dimmed, and ends the message with a box of what it
cited and their URLs (`plugins/lunette/hooks/issue-titles.mjs`). It is a
`MessageDisplay` hook: it changes the screen only, and what the agent wrote and reads
stays as it was. The titles come from `gh` for the session's repository, cached for a
day in the git directory. A delta waits for the cache and the titles at most `WAIT_MS`
(`issue-titles-hook.js`); a slower title shows in a later delta, in the box or beside
the number in the next message.

- **Shown as written:** code, `#0` (GitHub numbers from 1), and a number `gh` answers
  with HTTP 404 or 410 (a missing issue, or a repository the token cannot see).
- **No lookup for the session** when `gh` is missing (`gh --version` fails or does not
  answer in 3 s), not logged in, or the repository has no GitHub remote. A lookup
  that fails otherwise (past its 3 s timeout, the network, a rate limit) is tried
  again.
- **A title is anyone's text:** control, format and other invisible characters (line
  separators, variation selectors, the grapheme joiner) are dropped, and a URL is
  shown only when it is a plain `https` address, from `gh` or from the cache.

How a title is written is the `issues` skill's.

## Consequences

### Positive

- One skill serves every project, and an upstream fix reaches every project that
  updates it.
- A project's process is readable in one file of values and a few pages of prose, not
  scattered through skills, ADRs and instruction files.
- The operator profile follows its owner into every worktree and every agent that
  reads `.agents/`, and never lands in git.

### Negative / accepted risks

- The titles on screen are Claude Code's and the plugin's alone: another agent, a
  session without `gh`, or one where an organization manages Claude Code (plugin
  hooks on `MessageDisplay` run only for plugins it lists) shows numbers as written.
  A renamed issue shows its old title for up to a day, from the cache.
- Skills depend on `lntt`; a generated project needs it installed, which ties the
  template to a published `@lntt/lntt`.
- Reading the profile from the main checkout fails over to the home directory when the
  main checkout is gone; a profile kept only in a deleted clone is lost with it.
- The fixed list of areas is a contract between skills and projects: renaming an area
  means a coordinated change.

### When to deviate (revisit triggers)

- The `.agents/` convention (agentsmd/agents.md#71) settles on a place for local or
  personal context: move the profile there.
- A process area's values stop fitting a schema (every project needs free text): that
  area's content belongs in its process description.

## Discarded directions

- **Project values inside the skills, or in ADRs.** It is why the skills of two
  projects scaffolded from the same template diverged, and why ADRs mixed process with
  architecture.
- **Values in the frontmatter of each process description.** Seven files to read and
  validate instead of one, and no single schema.
- **Operator context in `~/.claude/CLAUDE.md`.** Read by one agent only, and it mixes
  every project into one file.
- **`CLAUDE.local.md`, or any untracked file in the working tree.** An untracked file
  exists only in the worktree where it was created; and a `CLAUDE.local.md` stops Claude
  Code from reading `AGENTS.md`.
- **A directory named after Lunette** (`.lunette/`). `.agents/` is the name agents
  already share.
- **A rule in AGENTS.md that an agent writes each issue's title beside its number.**
  Agents given it broke it in three samples of four, always the same way: an opening
  line repeating the numbers the person used, before any title. The reader needs to see
  what a number is, whoever wrote it.
- **A `Stop` hook that blocks a message with a bare number until the agent fixes it.**
  The message is already on screen when `Stop` runs, so the correction arrives as a
  second message, and a turn is spent on it.
- **The number as a terminal hyperlink (OSC 8).** Claude Code (2.1.303, October 2026)
  strips the escape in a hook's display text, so the sequence shows as written; a
  plain URL in the box is opened by the terminal.
