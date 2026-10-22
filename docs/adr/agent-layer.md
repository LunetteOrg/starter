---
status: accepted
date: 2026-10-22
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
  (one of the two), validated by `packages/lntt/schema/config.schema.json`, and by
  `lntt validate` for what a schema cannot express (a value that must name an entry
  of another list).
  Sections are named after fixed process areas (`recording`, `board`, `ci`,
  `delivery`, `cycle`, `spaces`, `team`, `local`); a section is added when a skill
  needs it. A short reason for a value is a comment next to it.
- **Prose** in `docs/process/<area>.md`: the mechanisms and longer reasons a value
  cannot express. Kept apart from technical decisions; it cites configuration keys and
  never repeats their values.

Scripts and skills read the configuration through `@lntt/lntt` (`lntt get <key>`),
never with `jq` or `JSON.parse`: the file has comments, and writes must keep them. A skill that finds its section missing stops and proposes it;
it never guesses.

### The shared skills come with `lntt`; a project holds their stubs

The shared skills (`commit-message`, `coordinate`, `decisions`, `review`, `run-local`)
ship inside `@lntt/lntt`, in `packages/lntt/skills/`. `lntt guide <skill>` prints a
skill's guide from the installed package, with the folder its relative links start
from, so a skill and the `lntt` it calls are always one version: the project's
lockfile.

`lntt sync` writes a stub of each skill into the two directories the clients read at
the project root, as their documentation states it in October 2026:

- `.agents/skills/`, read by Codex, OpenCode, Gemini CLI and Cursor;
- `.claude/skills/`, read by Claude Code, which reads no other project directory.

A stub folder holds its `SKILL.md` only, and `lntt sync` removes anything else from it.
The stub holds the skill's frontmatter, for discovery, a marker line, and one instruction:
load the guide with `pnpm exec lntt guide <skill>` before acting (a Lunette project
uses pnpm). The stubs are committed, so a fresh clone or a cloud session knows every
skill before an install. A bump of `@lntt/lntt` updates every guide with no other step;
the stubs change only when a skill is added, removed or redescribed. `lntt check
skills` fails on a stub that is missing or edited, or that names a skill the package
does not have; when to run `lntt sync` is in [delivery](../process/delivery.md#the-shared-skills).
The project's own skills sit beside the stubs and are left alone: `lntt sync` writes
nothing while a folder of the project's own has a shared skill's name, and `lntt check
skills` names it.
The other check areas skip the stubs.

### Operator context is personal and found from any worktree

The operator profile has its own schema (`packages/lntt/schema/operator.schema.json`:
name, handle, role, language, confidence per topic, accounts, workspace with the
preferred viewers and browsers in order) and is read,
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

In Claude Code the `lunette` plugin shows, beside the first `#N` or `owner/repo#N` of
each message, the title of that issue or pull request, dimmed, and ends the message
with a box of what it cited and their URLs (`plugins/lunette/hooks/issue-titles.mjs`).
It is a `MessageDisplay` hook: it changes the screen only, and what the agent wrote and
reads stays as it was.

The rules below, the cache and the `gh` lookups are `lntt refs`
(`packages/lntt/src/refs.ts`), for the hook and for any agent: it reads a text and
prints, as JSON, each reference with where it sits, its title and URL, or why it has
none. The titles come from `gh`, cached for a day in the git directory
(`lntt-issue-titles.json`, with the session's repository, which holds while the git
remotes `gh` resolves it from read the same, kept as their sha256 since a URL may hold
a credential: a fork, `gh repo set-default` or a changed URL asks for it again;
concurrent calls merge, the newest entry of each key kept, and an entry lost in a race
is only asked again): `#N` (and `repo#N` naming the same repository) from the session's
repository as `gh repo view` names it, `owner/repo#N` from that repository. The hook
keeps the display and calls `lntt refs`, the project's `node_modules/.bin/lntt`, else
`lntt` on `PATH`. A delta waits for lntt and the titles at most `WAIT_MS`
(`issue-titles-hook.js`); a slower title shows in a later delta, in the box or beside
the number in the next message. A reference belongs to the delta where it ends, and one
that ends a delta other than the last is read with the next delta, since it may go on
(`#1` | `38` is `#138`).

- **Never a title from the wrong repository:** a message that cites another
  repository shows every bare `#N` after that as written. Any other `word#N` is no
  reference (`C#5`, `fix#12`, `starter#94` written in another repository's session);
  when the word could be a repository name (three characters or more, a letter
  first) it counts as another repository. Names are compared in lower case.
- **Shown as written:** code, a link's URL (a title goes after the link, once the link
  is whole), `#0` (GitHub numbers from 1), a reference `gh` answers with HTTP 404 or
  410 (a missing issue, or a repository the token cannot see), and one `gh` answers
  with an empty title or a URL that is not a plain `https` address.
- **Nothing for the session** after `FAILURES` runs of `lntt` in a row that fail or
  find no session repository, and at once from an `lntt` with no `refs` (its usage,
  exit 2): the session then shows every number as written. A run fails when it cannot
  start, runs past `LNTT_TIMEOUT_MS` or answers no JSON with `mentions` and `refs`;
  it finds no repository when `gh repo view` fails or does not answer within
  `GH_TIMEOUT_MS` (`gh` missing, not logged in, no GitHub remote). Such a run shows
  its delta as written, with no reference, not even a cached one, and the next lookup
  runs `lntt` again; a run that finds the repository starts the count again. A lookup
  that fails otherwise (past `GH_TIMEOUT_MS`, the network, a rate limit) is tried
  again. A `ref` from `lntt` that is not a lower-case `owner/repo#N` is ignored.
- **A title is anyone's text:** control, format and other invisible characters (line
  separators, variation selectors, the grapheme joiner) are dropped, and a URL is
  shown only when it is a plain `https` address, from `gh` or from the cache.

How a title is written is the `issues` skill's.

## Consequences

### Positive

- One skill serves every project, and an upstream fix reaches every project that
  updates it.
- One install path and one version for every agent: a bump of `@lntt/lntt` updates the
  skills of Claude Code and of every other client, and the `lntt` they call with them.
- A project's process is readable in one file of values and a few pages of prose, not
  scattered through skills, ADRs and instruction files.
- The operator profile follows its owner into every worktree and every agent that
  reads `.agents/`, and never lands in git.

### Negative / accepted risks

- A `gh repo view` slower than `GH_TIMEOUT_MS` (a slow network) leaves every number
  as written until a later call gets the repository.
- Another repository's issue gets a title only when cited as `owner/repo#N`; a short
  `repo#N` from a session in another repository is shown as written.
- Prose with a word before `#` that could be a repository name (`issue#4`, `fix#12`)
  leaves every bare `#N` after it in that message as written: titles are lost where
  they would have been right, so that none is ever wrong.
- The titles on screen are Claude Code's and the plugin's alone: another agent, a
  session without `gh`, or one where an organization manages Claude Code (plugin
  hooks on `MessageDisplay` run only for plugins it lists) shows numbers as written.
  Another agent can resolve its references with `lntt refs` before writing, so its
  text carries the titles. A renamed issue shows its old title for up to a day, from
  the cache.
- Each delta that holds a number starts one `lntt` process (`lntt refs --cached`, with
  the message so far on stdin) within `WAIT_MS`: a machine slow to start Node shows
  more titles a delta late.
- Skills depend on `lntt`; a generated project needs it installed, which ties the
  template to a published `@lntt/lntt`.
- Reading the profile from the main checkout fails over to the home directory when the
  main checkout is gone; a profile kept only in a deleted clone is lost with it.
- The fixed list of areas is a contract between skills and projects: renaming an area
  means a coordinated change.
- OpenCode and Cursor read both skill directories, so each stub reaches them twice.
- A stub's guide needs the install: in a fresh clone the agent finds the skill, and
  `lntt guide` fails until `pnpm install` has run.
- Every skill load costs one command, the guide's, before the agent acts.

### When to deviate (revisit triggers)

- The `.agents/` convention (agentsmd/agents.md#71) settles on a place for local or
  personal context: move the profile there.
- A process area's values stop fitting a schema (every project needs free text): that
  area's content belongs in its process description.
- Claude Code draws terminal hyperlinks (OSC 8) in a hook's display text: the number
  itself can link to its issue.
- Claude Code reads `.agents/skills/`: `lntt sync` stops writing `.claude/skills/`.

## Discarded directions

- **Project values inside the skills, or in ADRs.** It is why the skills of two
  projects scaffolded from the same template diverged, and why ADRs mixed process with
  architecture.
- **Checking the references between lists on every load and in `lntt set`.** A typo
  on the board would fail every reader of the configuration (commitlint, `lntt ci`),
  and renaming a status option would take a value that is wrong in between.
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
- **The number as a terminal hyperlink (OSC 8).** The sequence showed as written in a
  hook's display text when it was tried; a plain URL in the box is opened by the
  terminal (see the revisit triggers).
- **`repo#N` read as a repository of the session's owner.** A word before `#` is often
  no repository (`fix#12`, `jira#9`): each cost a lookup that failed, and a wrong owner
  gave a wrong title or none.
- **A list of words that are not repositories** (`issue`, `bug`, `task`). A closed list
  lets every other word through; a word that could be a name is treated as another
  repository instead.
- **The skills from the Claude Code plugin, and `npx skills add` for other agents.** Two
  install paths, and a plugin version beside the packages' one; the plugin keeps only
  the hooks, which a skill directory cannot carry (the `lntt review` band, the issue
  titles on screen).
- **Full copies of the skills, resynced at each bump.** Every bump of `@lntt/lntt` is
  also a diff of every guide, and a project that skips `lntt sync` runs skills of one
  version against an `lntt` of another.
- **`npx skills add` pinned to a git hash.** A second version to keep in step with the
  package's, outside the lockfile.
- **Stubs generated and git-ignored.** No diff ever, but a fresh clone or a cloud
  session does not know the skills exist until `pnpm install` runs.
- **Symlinks into `node_modules/@lntt/lntt`.** They dangle in a fresh clone until an
  install, and a checkout without `core.symlinks` (Windows) turns them into text files.
- **`npx skills experimental_sync` writing the stubs.** It installs the skills a
  dependency ships at `skills/` or `dist/skills/`: the guides, not stubs, unless the
  package shipped the stubs there and the guides elsewhere. It is marked experimental,
  keeps a lock file of its own, and the check that a stub is unedited would still be
  `lntt`'s.
