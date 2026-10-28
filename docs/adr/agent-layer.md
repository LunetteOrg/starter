---
status: accepted
date: 2026-10-28
tags: [agents, skills, configuration, operator, templates, hooks, plugin]
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
  of another list) and for what every reader would fail on if the schema required it
  (a key the skills need, so a section written in steps still loads).
  Sections are named after fixed process areas (`recording`, `board`, `ci`,
  `delivery`, `cycle`, `spaces`, `team`, `local`, which holds the commands of the
  agent's hooks beside the local apps); a section is added when a skill needs it. A short reason for a value is a comment next to it. A section that a
  platform serves names it (`board.provider`), keeps that platform's own keys under its
  name (`board.github`) and the concepts every platform shares beside it; a skill of
  that platform, its adapter, does the reads and writes (`github-board` for `github`),
  and the other skills hand them to it.
- **Prose** in `docs/process/<area>.md`: the mechanisms and longer reasons a value
  cannot express. Kept apart from technical decisions; it cites configuration keys and
  never repeats their values.

Scripts and skills read the configuration through `@lntt/lntt` (`lntt get <key>`),
never with `jq` or `JSON.parse`: the file has comments, and writes must keep them. A skill that finds its section missing stops and proposes it;
it never guesses.

### The shared skills come with `lntt`; a project holds their stubs

The shared skills (`commit-message`, `coordinate`, `decisions`, `github-board`,
`plan-round`, `retrospective`, `review`, `roadmap`, `run-local`) ship inside
`@lntt/lntt`, in `packages/lntt/skills/`.
`lntt guide <skill>` prints a skill's guide from the installed package, with the folder
its relative links start from, so a skill and the `lntt` it calls are always one
version: the project's lockfile.

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

### Where hooks live

A hook goes in the `lunette` plugin only when a project setting cannot carry it: the
hooks that change what Claude Code draws (the `lntt review` band above the prompt and
`/review-status`, the issue titles in a message). Every other hook goes in the
project's `.claude/settings.json`, written by `lntt sync` beside the project's own
hooks, as a thin line that calls `lntt` with its logic in the package (`lntt hook
<name>`, `packages/lntt/src/hook.ts`).
A settings line runs the worktree's `lntt` and reaches a cloud session; the plugin
does neither (below). It is the path the skills take, and `lntt sync` can write the
same line in another agent's hook format.

The plugin ships inside `@lntt/lntt`, in `packages/lntt/plugin/`, at the package's
version, with the marketplace that lists it at the package root
(`.claude-plugin/marketplace.json`). It sits in a folder of its own because Claude Code
reads a plugin root's `skills/` and `agents/` as components, and the package root holds
the guides and the `AGENTS.md` block there. `lntt sync` writes into
`.claude/settings.json` a `directory` marketplace, `./node_modules/@lntt/lntt`, and
enables the plugin from it; `lntt check plugin` fails while either is missing or points
elsewhere. A file that is not JSON, or whose keys do not have the shape Claude Code
reads, `lntt sync` refuses without writing: it is fixed by hand first. Once the folder
is trusted Claude Code loads the plugin in place at every session start, with no install
step and whatever its version string, so a bump of `@lntt/lntt` is its update. The path
resolves against the main checkout: every worktree of a repository loads the plugin the
main checkout installed (Claude Code's documentation of plugins for an organization,
October 2026). The plugin cannot import `lntt`, so it reads `.claude/settings.json` with
a reader of its own, which drops comments, trailing commas and a leading byte order mark
as `lntt` does (`lntt sync` writes the file back without the mark).

Three settings hooks are Lunette's (`packages/lntt/src/claude-settings.ts`), each told
from the project's own by its `statusMessage`: `lntt sync` replaces a hook with that
message and a different line, so the message of a hook stays the same across versions.

- **Install**, at `SessionStart`: when `node_modules/.bin/lntt` is missing, it installs
  the dependencies with pnpm, the manager of a Lunette project, or with `npm ci` in a
  project that has only a `package-lock.json`; another lockfile (yarn, bun) gets pnpm
  too. It installs `lntt`, so it is a shell line, not `lntt hook`.
- **Format**, after `Write` and `Edit`: `lntt hook format` passes the written file to
  the format commands. The file is formatted while the agent works on it, so the
  pre-commit, which formats the staged files and stages the fix, does not rewrite it
  under the agent. A command that fails on the file (a type it does not handle) is
  skipped.
- **Typecheck**, at `Stop`, in the background: `lntt hook typecheck` runs the typecheck
  commands and wakes the agent with the output of a failure, so the first real error
  reaches it at once rather than at the next commit. It wakes only on a failure it has
  not seen: the last failing output, without colours and timings, is kept in the
  worktree's git directory (outside git, in the temporary directory), a run that fails
  the same way stays quiet, and a green run clears it.

The commands are a project's: `local.hooks.format` and `local.hooks.typecheck` of
`.agents/config`, one command or a list run in order (a project with more than one
toolchain, such as `tsc` and `mypy`, every one of which must pass); without the key, the
`package.json` script of the same name; without both, the hook does nothing and says
nothing. They run from the project root, within one limit for the whole list (a minute
for the format commands, ten minutes for the typecheck's), below the hook's own timeout
in the settings. Each runs in a process group of its own: at the limit the whole group is
stopped, the processes it started included (`tsc` under `pnpm run`), and the commands
left are not run; the typecheck reports both as part of its failure. Its output reaches
the agent up to 64 MB.

`lntt hook` answers its settings line with an exit code: 0 nothing to report, 1 a
typecheck failure not reported yet (the line exits 2, which wakes the agent with the
output), 2 the usage, which an `lntt` older than `hook` also answers. A defect of the
typecheck hook itself (its own error, a state it cannot read or write) never wakes the
agent: it exits 0 with a `systemMessage` once per session, which Claude Code gives the
agent at its next turn.

Every other hook is measured before it is adopted: what it costs in tokens and turns
against what it catches that the next gate (the pre-commit, `ci:local`, the review) would
catch later at a higher cost. The measure of October 2026, on the Claude Code transcripts
of three Lunette projects (about 2,400 sessions, 1,381 commits): the typecheck at `Stop`
woke the agent 77 times, 66 of them in one project, where 65 rewakes changed nothing
while the typecheck stayed red, for 203 model calls and 85k output tokens; the waking on
a new failure only removes that repetition. The formatting hook ran 2,040 times and
caused 281 file-changed notices (about 56k tokens) for the formatting the agent would
otherwise meet at the commit. None of the other hooks measured pays for itself today (see
the discarded directions).

A mechanism of the plugin or a hook of `lntt` that cannot work never errors and never
blocks a turn: it says once per session what is missing and the command that fixes it,
after a fix by hand when `lntt sync` cannot read the file
(`packages/lntt/plugin/hooks/notices.mjs`). The band says it in the band, until the
first message ends (`.claude/settings.json` not as `lntt sync` writes it); the titles at
the end of a message (`lntt` not installed, an `lntt` with no `refs`, `gh` missing or
not logged in); a settings hook in a `systemMessage`, which Claude Code shows the
person for the install and format hooks and gives the agent at its next turn for the
typecheck, which runs in the background. A configuration `lntt` cannot read is said once
until it changes, where each hook speaks: the typecheck wakes the agent with it, as a
failure; the format hook, which is then off, tells the person in a `systemMessage`.

### What a number means is shown on screen, not asked of the agent

In Claude Code the `lunette` plugin shows, beside the first `#N` or `owner/repo#N` of
each message, the title of that issue or pull request, dimmed, and ends the message
with a box of what it cited and their URLs (`packages/lntt/plugin/hooks/issue-titles.mjs`).
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
the number in the next message. The titles still missing are asked in `lntt refs` runs
of at most `KEYS_PER_RUN` references, side by side, so that one run fits
`LNTT_TIMEOUT_MS` however many a message cites; the runs of one lookup count as one
failure at most. A reference belongs to the delta where it ends, and one that ends a
delta other than the last is read with the next delta, since it may go on (`#1` | `38`
is `#138`); so is one inside a `[` still open, since it may become a link's text (its
title then goes after the link). A newline, or the last delta, ends that wait; a
reference held for a link that does not form gets its title in the box only.

- **Never a title from the wrong repository:** a message that cites another
  repository shows every bare `#N` after that as written. Any other `word#N` is no
  reference (`C#5`, `fix#12`, `starter#94` written in another repository's session);
  when the word could be a repository name (three characters or more, a letter
  first) it counts as another repository. Names are compared in lower case.
- **Shown as written:** code, a link's URL (a title goes after the link, once the link
  is whole), `#0` (GitHub numbers from 1), a reference `gh` answers with HTTP 404 or
  410 (a missing issue, or a repository the token cannot see), and one `gh` answers
  with an empty title or a URL that is not a plain `https` address.
- **Nothing for the session** after `FAILURES` failures in a row, a failure being a
  call of `lntt` that fails or finds no session repository (the runs of one lookup
  count as one call), and at once from an `lntt` with no `refs` (its usage,
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

How a title is written is the `github-board` skill's.

## Consequences

### Positive

- One skill serves every project, and an upstream fix reaches every project that
  updates it.
- One install path and one version for every agent: a bump of `@lntt/lntt` updates the
  skills of Claude Code and of every other client, the plugin, and the `lntt` they call
  with them.
- A project's process is readable in one file of values and a few pages of prose, not
  scattered through skills, ADRs and instruction files.
- The operator profile follows its owner into every worktree and every agent that
  reads `.agents/`, and never lands in git.

### Negative / accepted risks

- The plugin needs `node_modules` in the main checkout: a fresh clone shows no band and
  no titles until the install, which the `SessionStart` hook runs, and the next session.
  A worktree whose `lntt` is newer or older than the main checkout's runs the main
  checkout's plugin against it; an output the plugin does not know is ignored.
- A cloud session adds no `directory` marketplace: it has the skills and the settings
  hooks, not the band or the titles.
- The format hook adds a file-changed notice to the context after each edit it
  reformats; the typecheck runs at every `Stop`, in the background, and a failure that
  changes at each run wakes the agent at each run.
- A settings line of `lntt hook` that meets an `lntt` with no `hook` says what to run once
  per Claude Code process, which is the session's; with `lntt` missing it says nothing.
  A configuration `lntt` cannot read turns the format hook off until it is fixed.
- Claude Code keeps one registered `lunette` marketplace per machine: each Lunette
  project's session start points it at that project's path, and every session loads
  its own project's copy (observed with Claude Code 2.1.312, two projects in one
  configuration).

- A `gh repo view` slower than `GH_TIMEOUT_MS` (a slow network) counts as a failed
  `lntt refs` call: `FAILURES` of them in a row turn the titles off for the session, and
  they come back only in a new session.
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
  the message so far on stdin) within `WAIT_MS`, and one more for each `KEYS_PER_RUN`
  titles still missing: a machine slow to start Node shows more titles a delta late.
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
- Claude Code resolves a `directory` marketplace against the worktree, or cloud sessions
  add one: the plugin follows the worktree's `lntt` everywhere, and the display hooks
  stop needing the main checkout.
- A gate moves (the pre-commit stops running the typecheck or the formatter) or a
  Claude Code release changes what a hook costs: the discarded hooks below are measured
  again.

## Discarded directions

- **The plugin from the starter's GitHub marketplace.** It updated at its own version
  string while a project's `lntt` is the version in its lockfile, so the hooks that call
  `lntt` drifted from it, and each machine installed it once by hand.
- **The plugin at the package root.** Claude Code would load the guides in `skills/` as
  plugin skills and `agents/block.md` as a subagent.
- **Command hooks in the plugin.** They would run the main checkout's `lntt` in every
  worktree and miss cloud sessions; a settings line has neither limit.
- **A typecheck at `Stop` that wakes the agent at every red run.** While the typecheck
  stayed red it woke a turn that changed nothing at each `Stop` (65 of one project's 66
  rewakes); the waking on a new failure only keeps the first.
- **The typecheck and the formatting left to the pre-commit alone.** The first real
  error reaches the agent a commit later, and the commit rewrites under the agent the
  files it formats.
- **The hooks' commands fixed by Lunette (`pnpm typecheck`, Biome).** A project with
  another toolchain, or more than one, could not use them.
- **A reminder to triage after `gh issue create`.** A project with it and one with only
  the `github-board` skill left the same share of issues untriaged.
- **Starting a cloud session (the Node version, the local services).** No cloud session
  of a Lunette project to measure it on; it is measured when there is one.

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
