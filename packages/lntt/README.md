# @lntt/lntt

The `lntt` command, for the people and the agents of a Lunette project: its
configuration and the operator profile, the managed block of `AGENTS.md`, the checks and
the review of a change, branch names, the apps run locally, and its CI run on the local
machine with the candidate automation ([`lntt ci`](#ci-lntt-ci)).

## The configuration

Reads, validates and edits a Lunette project's configuration: the values skills and
scripts need, in `.agents/config.jsonc` **or** `.agents/config.yml` at the repository
root (one of the two; both is an error). Sections are named after process areas
(`recording`, `board`, `ci`, `delivery`, `cycle`, `spaces`, `team`, `local`) and the
tools that read them; [`schema/config.schema.json`](./schema/config.schema.json) says
what each one holds.

Both formats allow comments: a short reason for a value goes next to it. So scripts
never parse the file themselves (`jq` and `JSON.parse` reject comments), and writes go
through an editor that keeps them.

```sh
lntt path                       # the file in use
lntt validate                   # exit 0 when it matches the schema, every value naming another list is in it, and the board has its horizon
lntt get recording.logs         # a dotted key, as plain JSON (pipe it to jq)
lntt set recording.language '"it"'   # a JSON value, comments kept
```

Exit codes: 0 ok, 1 configuration error, 2 usage error.

## The operator profile

Who is talking to the agent: personal, never tracked, validated by
[`schema/operator.schema.json`](./schema/operator.schema.json) (name, handle, role,
language, confidence per topic, accounts, workspace: the preferred viewers in order). Read from, in merge order:

1. `~/.agents/operator.{jsonc,yml}`: every project;
2. `<main checkout>/.agents/local/operator.{jsonc,yml}`: this project, found from any
   worktree through `git rev-parse --git-common-dir`;
3. otherwise `~/.agents/projects/<org>/<repo>/operator.{jsonc,yml}`: this project, when
   the main checkout has none (a fresh clone, a cloud session).

The project profile wins key by key. With none at all the speaker is a developer.

```sh
lntt operator                 # the merged profile
lntt operator get language    # one key
lntt operator sources         # the files it came from
```

Editors validate the file against the schema through its first line:

```jsonc
{ "$schema": "<path or URL of config.schema.json>", … }
```

```yaml
# yaml-language-server: $schema=<path or URL of config.schema.json>
```

## Commit messages

`commitlintConfig()` builds a commitlint configuration from `delivery.commits`
(language, scopes, line length, trailers exempt from it), with rules whose messages say
what to write instead and name the `commit-message` skill:

```js
// commitlint.config.mjs
import { commitlintConfig } from '@lntt/lntt'
export default commitlintConfig()
```

## AGENTS.md and the shared skills

`lntt sync` writes the managed block of `AGENTS.md` from
[`agents/block.md`](./agents/block.md), and a stub of each shared skill the package
ships ([`skills/`](./skills/): `commit-message`, `coordinate`, `decisions`,
`github-board`, `plan-round`, `retrospective`, `review`, `roadmap`, `run-local`) into
`.agents/skills/` and `.claude/skills/`; commit them. A stub holds the
skill's frontmatter, for discovery, and the instruction to load its guide:

```sh
pnpm exec lntt guide decisions   # the guide, from the installed package
pnpm exec lntt guide             # the skills it has
```

So the skills and the `lntt` they call are one version, the project's lockfile: a bump
of `@lntt/lntt` updates the guides with no other step. `lntt check agents-md` fails
when the block differs from its source; `lntt check skills` when a stub is missing or
edited, or names a skill the package no longer has. Either way, `lntt sync` runs on the
branch of the bump and its diff goes in the same pull request
([agent layer](../../docs/adr/agent-layer.md)).

## Checks (`lntt check`)

What is checked without judgement, one area per review lens, so a reviewer reads the
result instead of redoing it by eye.

```sh
lntt check                                              # every area: what CI runs
lntt check agents-md                                    # the managed block of AGENTS.md
lntt check skills                                       # the stubs of the shared skills
lntt check decisions                                    # the decision logs of recording
lntt check decisions --base main                        # … and what the diff from main touches
lntt check decisions numbers docs/adr/review-agents.md  # every line carrying a figure
lntt check tests                                        # levels, focus, rules (touched needs --base)
lntt check tests touched --base main                    # the changed lines and the tests that run them
lntt check tests mutate src/a.ts:12 --text='a > b' --to='a < b'   # does a test fail?
lntt check cite docs/adr/review-agents.md:12 a.ts:40    # what is on those lines
lntt check --json                                       # one JSON line per result
```

Every check reports `PASS`, `FAIL` or `NOT RUN` with its reason: an area or a log the
project has not configured is `NOT RUN`, never a silent pass. `INFO` is printed without
passing or failing (the diff inventory, the figures). Exit 1 on a `FAIL`, 2 on a usage
error. `--json` prints one line per result: `area`, `check`, `status`, `path`, `line`,
`message`.

`lntt check decisions` (or `decisions structure`) reads every log of `recording.logs`:

- **index:** no index row without its file, no record left out of the index, a row
  labelled with a subject points at that subject's file. A log with no `index` is
  `NOT RUN`.
- **references:** every relative link into a log and every path to a record
  (`docs/adr/<subject>.md`, in a document or in code, also wrapped over two lines)
  resolves to a file that exists; a record cited by number (`ADR-NNNN`) is an error.
  Files that cite the records of the project they ship to, not this one's, are listed
  in `recording.externalReferences` with their reason; a glob that matches no file
  fails.
- **residues:** no append-only marker in a record (`Superseded by`, `Supersedes`,
  `Amended by`, `## Update`, `## Addendum`, struck-through text, their Italian forms),
  outside code spans.
- **names:** the file name is the subject in kebab-case (no number, no date), the title
  carries no number, and the status is one the log's `template` lists in its
  frontmatter (`status: proposed # proposed | accepted`).

With `--base <ref>` it adds the **inventory** of the diff (`<ref>...HEAD`: each record
added, modified, deleted or renamed, and the other files), checks residues and names on
the records the diff touches only, and prints the **figures** of those records.
`numbers` prints the figures alone: every line carrying a percentage, an "N of M" or a
number of two digits or more, the frontmatter, issue numbers and dates apart. Files of a
nested project (a folder with a `.agents/config.*` of its own, a template) are that
project's check.

`lntt check tests` reads `tests` of the configuration (the
[record](../../docs/adr/test-checks.md) says why and how):

- **levels:** each test file (`*.test.*`, `*.spec.*` or a level's `files`) at exactly one
  level of `tests.levels`, and a file at a level with a `harness` names one of its
  identifiers. The pyramid per level, what the diff adds to each and the jsdom tests
  that stub a Web API are `INFO`.
- **focus:** `.only` (always), `.skip` and todo (the diff's, or all without `--base`),
  a test with no assertion (`tests.assertions` adds functions that throw).
- **rules:** `tests.rules`, a regular expression per line of the test files, each with
  its `anchor`; a rule with `assertedBy` is cited, not checked.
- **touched** (`--base`): per changed source file, the tests that run its changed lines
  (from the `coverage` command of their level, an lcov file at `{out}/lcov.info`) and
  the lines no test runs; without `coverage`, the tests that import the file.
- **mutate** `path:line --text=<on that line> --to=<mutated>`: applied in a scratch git
  worktree (the head and the uncommitted files, dependencies shared; the working tree is
  never written), runs the tests that import the file with the `run` command of their
  level, `repeat` times in a row. `PASS` is killed (the failing test and its message),
  `FAIL` survived, `NOT RUN` when the text is not once on the line or the tests fail
  without the mutation. Write `--text=...` with the `=` when the text starts with `-`.

`cite` reads the working tree: the text of each line, or `FAIL` when the file or the
line does not exist.

## Branch names

```sh
lntt branch name --issue 77          # feat/77/branch-names-follow-type: type, issue, slug of the title
lntt branch name --issue 77 --slug worktree-names   # --type and --slug override
lntt branch name --type docs --slug version-numbering   # docs/no-issue/version-numbering
lntt branch check                    # exit 1 off the convention, with the expected name
lntt branch check --pre-push         # the branches a push creates or updates (git's hook input)
lntt branch rename                   # fix the name a tool gave the current branch; never fails
```

The convention is `<type>/<issue>/<slug>` or `<type>/no-issue/<slug>`; the types are
`delivery.branches.types` plus the hotfix prefix, and the base, the candidates and
Dependabot's branches are exempt. `name` reads the issue with `gh` (its native type,
else the labels `bug` and `documentation`, else `feat`). `rename` reads the convention
back from a flattened name (Orca's `<user>/<type>-<issue>-<slug>`, the agent harness's
`worktree-<type>+<issue>+<slug>`) or, inside Orca, builds it from the issue linked to the
worktree (`orca worktree current`); it leaves an existing branch alone.

## The pull request body

```sh
lntt pr block                        # the empty retrospective block, from the configuration
lntt check body                      # FAIL on a missing block, a missing, repeated or empty label
lntt check body --pr 171             # another pull request's body; `-` reads it on stdin
lntt check body template             # the template holds the block lntt pr block prints
lntt retro add --label friction "…"  # one item under a label of the open candidate's retrospective comment
```

The block is `delivery.pullRequest.retrospective`: its heading and its labels, each
written `- **<label>:** <value>` between `<!-- retro:start -->` and `<!-- retro:end -->`,
the markers on lines of their own. A value may run on the lines below its label; an HTML
comment is no value; the configured `none` is an answer. `lntt check body` is an area of
`lntt check` whose input is not in the repository: it reads the current branch's pull
request with `gh` unless told otherwise, and `lntt check` alone reports it `NOT RUN`.
Its `template` check reads the repository: the template at `delivery.pullRequest.template`
holds the block `lntt pr block` prints, so `lntt check` alone runs it. The `retrospective` skill fills the block and harvests the
merged pull requests' blocks.

A candidate's block is a comment, not its body: the candidate automation opens every
candidate with a comment holding the empty block, and never rewrites it as it rewrites
the body. `lntt retro add --label <label> "<one sentence>"` appends one item under that
label, on the open candidate unless `--pr <n>` names another pull request: the label is
the configured one equal to it ignoring case, or the only one it starts (`--label to`
is `To automate (hook/skill/agent)`); an empty label or `none` takes the item on its
line, a label with a value gets sub-bullets; the markers and the other labels stay.
With no comment holding the block, it writes one. On a candidate, `lntt check body`
reads that comment instead of the body: the first comment holding the start marker on a
line of its own.

An item whose friction comes from Lunette itself (`lntt`, a shared skill, the
scaffolder, a template) starts with `[lunette]`: `- **Friction:** [lunette] lntt review
…`, or a sub-bullet `  - [lunette] …`. `lntt check body` fails a marker with no sentence
after it, and one spelled otherwise at an item's start (`[Lunette]`, `[lntt]`,
`[upstream]`), naming `[lunette]`.

## Reports on Lunette itself

```sh
lntt dump [--json] [--harness <name>] [--model <id>] [-- <failing command>...]
lntt issue search <words>...         # the open issues upstream that match: one JSON line each
lntt issue draft.md                  # the whole issue, dump included; nothing sent
lntt issue draft.md --send           # opened with gh; prints its URL
lntt issue draft.md --comment 7 --send   # a comment on an existing issue instead
```

`lntt dump` prints, in Markdown (`--json`: one object), what a report on Lunette needs:
the `lntt` version and how it is installed, Node, the package manager and the OS, the
harness and its version (detected from the environment; `--harness` overrides) and the
model (`--model`: the agent knows it, the environment does not), the project's skills,
git and agent hooks, plugins, `@lntt/*` packages and configuration, and, after `--`, the
failing command, run again, with its exit code and the last 200 lines of its output. It
is redacted before it is printed: the home path becomes `~`, the project's git remotes
`<remote>`, a URL with credentials, an email, a token by its shape (GitHub, Anthropic,
OpenAI, Slack, AWS, npm, a JWT, a bearer), the value of a key that names a secret and the
value of every secret-named environment variable `<redacted>` or `<token>`.

`lntt issue <draft | ->` reads a draft (`# <title>`, then `## What happened`,
`## Pull requests`, `## Proposal`) and fills the fields of the report form
(`.github/ISSUE_TEMPLATE/lunette-report.yml` in the Lunette repository): the project
(`--project`, default the `name` of its `package.json`), the harness, the model and the
versions from the dump (`--dump <file>` from `lntt dump --json`, else collected now),
the whole dump folded at the end. Without `--send` it is a dry run: it prints the issue
and sends nothing, so the operator reads exactly what will be sent. It sends with `gh`,
under the operator's account, to `cycle.retrospective.upstream.repository`, by default
the `repository` of the installed `@lntt/lntt`. The `retrospective` skill drafts these
reports from the `[lunette]` items and calls `lntt issue`, never `gh`.

## Starting work on an issue

```sh
lntt worktree start --issue 78                 # a worktree, its setup, an agent with the brief
lntt worktree start --issue 78 --issue 85      # one each
lntt worktree start --issue 78 --no-agent      # the worktree only; the brief is printed
lntt worktree start --issue 78 --host git      # force the host
lntt worktree start --issue 78 --prompt '…'    # a prompt of your own instead of the brief
lntt worktree start --issue 78 --kind codex --model gpt-6 --effort high
```

Per issue: the branch name from `lntt branch name`, a worktree on it, the setup
`orca.yaml` declares, and an agent (`--kind`: claude by default, codex, opencode, …;
`--model` and `--effort` as that agent takes them, an effort it has no flag for is
refused; opencode gets its model through its inline configuration,
`OPENCODE_CONFIG_CONTENT`, on a standalone server) handed the brief in
[`agents/brief.md`](./agents/brief.md): the issue is the mandate, work only in this
worktree, review and `pnpm ci:local` green, a **draft** pull request, then stop (no
merge, no `gh pr ready`) and return a summary and the friction met. One JSON line per
issue: host, branch, path, and the agent's handle.

The host is the innermost one the session runs in, detected from the environment:

- **Herdr** (`HERDR_ENV=1`, also inside an Orca terminal): `herdr worktree create` on the
  branch, the setup run here (Herdr has no hook), `herdr agent start` in the new pane
  (model and effort after `--`), `herdr agent prompt` with the brief. opencode with a
  model is typed into the pane instead and prompted through the pane once Herdr detects it.
- **Orca** (`TERM_PROGRAM=Orca`): one `orca worktree create` with the issue linked, the
  setup run by Orca (its `lntt branch rename` turns `<user>/<name>` into the convention)
  and the agent started after it (`setupAgentStartupPolicy: wait-for-setup`). `--model`
  and `--effort` go on the same `worktree create` when its help lists them (1.4.229
  does), which refuses a combination the agent does not take before creating anything;
  the reply's `launch.outcome.handle` is the agent's handle. On an Orca whose `worktree
  create` takes no model (1.4.224): the worktree with its issue and Orca's setup
  skipped, the setup run by `lntt`, then a supervised worker on it (`orca orchestration
  worker-start`, in a Run created when none is bound to the terminal). opencode with a
  model starts in a terminal of its own instead (Orca refuses an opencode model to its
  worker), and gets the brief once idle.
- **Plain git** otherwise, Wave and Claude desktop included: `git worktree add` under
  `<main checkout>/.worktrees/`, the setup, and the brief printed for the person.

## Coordinating a theme

A theme is several issues at once. Its coordinator is a worktree that writes no code and
starts one child per issue ([coordinator mode](../../docs/adr/coordinator-mode.md); the
instructions are the shared `coordinate` skill).

```sh
lntt worktree start --coordinator --theme release-0-6-1 --issue 84 --issue 89 --approve 89
lntt worktree start --theme release-0-6-1 --parent current --issue 89 \
  --context theme-89.md --size S [--base <branch>] [--workflow]
```

- `--coordinator` starts the theme's coordinator on the model of `coordinator.models.coordinator`,
  with [`agents/coordinator.md`](./agents/coordinator.md); `--approve` lists the children it
  may start without asking.
- `--theme` makes a child the theme's: `--context` is the child's section of the theme,
  rendered into its brief; `--size` picks its model from `coordinator.models.children`
  (`--kind`, `--model` and `--effort` win); `--parent` is the coordinator's worktree for Orca's
  lineage; `--workflow` adds the multi-agent section ([`agents/workflow.md`](./agents/workflow.md)).
- With `coordinator.gate` at `propose` (default), a child not yet approved is proposed to the
  orchestrator and nothing is created until it answers `approve`.

The agents talk through the mailbox, which needs no Orca or Herdr:

```sh
lntt ask --to coordinator --theme release-0-6-1 "Which pull request first?"   # waits; stdout is the answer
lntt inbox --as coordinator --theme release-0-6-1 [--wait]    # unanswered messages, one JSON line each
lntt answer 20261017-101500-which-pull-request "The CLI one."
```

A message is `<git common dir>/lntt-messages/to-<role>/<YYYYMMDD-HHMMSS>-<topic>.md`, its answer the
same name ending in `.answer.md`; polled every 20 seconds (`LNTT_POLL_SECONDS`). A child is
addressed by `--issue`, a coordinator by `--theme`. `--timeout <s>` ends a wait with exit 1 and
leaves the message in place; `-` reads the text from stdin; `LNTT_ROLE`, `LNTT_THEME` and
`LNTT_ISSUE` default `inbox`'s role and address.

## Reviewing a change

```sh
lntt review                       # one round on the current branch; JSON on stdout
lntt review --base <branch>       # against another base (a stacked pull request)
lntt review --plan                # the range, the lenses and their agents; runs nothing
lntt review reply f2 "line 120 excludes it"   # answer the reviewers who found f2
lntt review allow 2               # two rounds more for this branch, past maxRounds
```

A round, on a clean working tree:

1. **What to read:** the branch from where it left the base the first time, then only
   the commits after the last reviewed one (after a rebase, the whole branch again).
   The state is `lntt-review.json` in the worktree's git directory.
2. **Checks**: a lens named after an area of `lntt check` (`decisions`, `tests`) gets
   `lntt check <area> --base <first commit read> --json` in its prompt, and its brief
   keeps only what needs judgement.
3. **Reviewers**, all at once: every agent of every lens in `delivery.review.reviewers`
   whose `paths` the diff touches. `decisions`, `code` and `tests` ship their briefs in
   [`agents/review/`](./agents/review/); another lens brings its own `brief`. Each agent
   runs headless with no context but its prompt (on stdin) and no tool that writes:
   `claude -p` with only Read, Grep and Glob and no MCP server; `opencode run` on a
   standalone server with an inline agent that denies every tool and allows read, grep,
   glob and list back. `--plan` and every round name where the diff goes: the provider
   of each configured agent.
4. **Citations**: `lntt check cite` reads the line of every finding (the working tree,
   clean at the head). A finding on a line past the end of its file is refuted there,
   with no verifier; the others take the line's text to their verifiers. A file that is
   not there goes to the verifiers: the change may delete it.
   **Mutations**: a `tests` finding that ends with ``mutate: `text` => `mutated` `` is
   run between the reviewers and the verifiers (`lntt check tests mutate`, one scratch
   copy for the round): survived confirms the finding and killed refutes it, the run
   being the proof, with no verifier asked.
5. **Verifiers**, all at once: each blocker and warning (`delivery.review.verify`) goes
   to every verifier but the agents that found it, briefed to refute it
   ([`agents/verify.md`](./agents/verify.md)). All confirm: confirmed. All refute:
   refuted. Otherwise undecided. Findings still open from the last round go back to
   them on the new head.

Progress goes to stderr (tokens per agent, `round N done`) and, as JSON events with the
pid of `lntt review` and a beat every 15 seconds, to `<git dir>/lntt-review.progress`
for a band beside the agent. Under Claude Code in Orca each agent shows as a subagent
of the session; agents never inherit the host's hook variables. On macOS `caffeinate`
keeps the machine awake for the round.

stdout is the round: `findings` to act on, `refuted` with their proofs, `failed`
reviewers and verifiers, `cost` in USD when the agents report it (claude does). Exit 0
when no blocker or warning is left and nothing failed, 1 otherwise; notes are reported
and do not block, nor are they carried to the next round. A reply that is neither
finding lines nor `no findings` counts as a failed reviewer; after a failure the next
round reads the same range again. A reviewer is stopped after
`delivery.review.timeoutMinutes` and counts as failed; at most
`delivery.review.perProvider` required agents of one provider run at once, and as many
optional ones in a queue of their own, the whole round (or a reply) stops at `delivery.review.roundTimeoutMinutes`, an
agent that ignores SIGTERM is killed, and one round or reply runs at a time in a
worktree. An agent marked
`optional` that fails is reported in `skipped` and does not fail the round; it is stopped
`delivery.review.optionalGraceMinutes` after the others have answered. A round that
cannot start prints `lntt review: error: …`. Agents that are not installed, or
that cannot be made read-only, are refused before any starts.

`reply` resumes the sessions of the reviewers who found the finding with the author's
answer ([`agents/reply.md`](./agents/reply.md)); the finding closes when all withdraw it.
A finding whose reviewer cannot be resumed is refused: the person decides on it.

A branch takes at most `delivery.review.maxRounds` rounds, one with a failure among
them. The round past the limit does not start: `lntt review: limit: …` on stderr with the findings still open, the
same findings as JSON on stdout, a `limit` event in the progress file, exit 3. `allow`
gives the current branch more rounds, kept in its state; the configuration and the
other branches stay as they are. A run with no new commit is not a round and is never
stopped.

## Running the apps locally

`local.apps.<name>` describes each app: base `port`, `url`, `commands` (with `start`),
`env`, `signIn` (a test and/or a document) and seeded `users`, never a password.
`lntt local app <name>` resolves it for the current checkout: the main checkout
uses the base port, each linked worktree a stable slot (base + 10 × slot, kept in
`<git common dir>/lunette/ports.json`, freed when the worktree goes), with `{port}`
filled in. The `run-local` skill starts from it.

## Showing a page

```sh
lntt viewer detect        # where the session runs, the chosen viewer, why
lntt viewer open <url>    # open it there; exit 3 + JSON when only the agent can
```

The choice: the first of the operator's `workspace.viewers` available in this
session, else the app the session runs in (Orca opens in the browser of the same
worktree), else the system browser. Claude desktop (`preview_start`) and Chrome
(`navigate`) are tool calls only the agent can make: `open` prints the call.

## Driving a browser

```sh
lntt browser [<app>] [--json]   # how an agent drives a browser on <app>, in this worktree
```

It prints, for the app's URL on this worktree's port, which browser to drive and why,
then one line per operation: `open`, `read` (an accessibility snapshot with element
refs), `click`, `type`, `screenshot` (to a file), `console` (errors), `requests` and
`close`, after a `setup` where the driver needs one. `<app>` may be omitted when
`local.apps` has one app; `--json` prints the same as one object.

The choice: the first of the operator's `workspace.browsers` usable in this session,
else the app the session runs in (Orca drives the browser of the same worktree,
Claude desktop its built-in browser), else Playwright through `npx @playwright/cli`,
in a session named after the app and port and writing its files outside the
worktree. Orca and Playwright are shell commands; Chrome and Claude desktop are tool
calls only the agent can make, printed with the call that loads them. Chrome counts
wherever it is listed, since no shell can tell whether a session has its tools: it goes
after the browsers that are detected.

## Issue and pull request references

```sh
lntt refs '#12' o/r#3                # these references, with their titles
git log -1 --format=%B | lntt refs   # every reference of a text on stdin
lntt refs --cached < message.md      # only what the cache holds: no gh call per issue
```

A bare `#N` (or `repo#N` naming the session's repository) is the session's repository
as `gh repo view` names it, `owner/repo#N` is that repository, any other `word#N` is no
reference; code and link URLs are not read, and after a reference to another
repository a bare `#N` is left unresolved. Titles come from `gh api`, six at once, three
seconds at most each, cached for a day in `<git dir>/lntt-issue-titles.json` with the
session's repository, which holds while the git remotes read the same (the cache keeps
their sha256, never a URL); without the session's repository nothing is looked up.
The output is one JSON object:
`repository`, `mentions` (each reference-looking match with its `ref`, its `index` and
the `after` position where a title goes, UTF-16 indices into the text) and `refs`
(each reference once with its `title` and `url`, or a `why`: `unknown`, `failed`,
`off`, `cached`). The `lunette` plugin's hook shows these titles on screen.

A text that starts with `-` goes after `--` (`lntt refs -- '-see #12'`). Exit codes: 0
with the JSON, also when `gh` is missing or not logged in (each reference's `why` is
`off`); 1 when the text cannot be read or the command fails, one line on stderr; 2 a
usage error, as with no text and a terminal on stdin.

## The board (`lntt board sync`)

```sh
lntt board sync            # what the Project and the issue types lack, read from GitHub: a dry run
lntt board sync --apply    # makes those changes, then reads the board back
lntt board sync --check    # exit 1 when the board differs from the configuration: for a hook or a scheduled job
```

It brings the GitHub Project of `board.github.project` and its organization's issue
types to what the `board` section declares. Through the API, each change keeping the
id of what it changes, so no item or issue loses a value:

- a missing field of `board.fields` (single select with its options, date, number, text);
- a missing option, and the colors of `board.fields.<key>.colors` (an option left out
  keeps its color, a new one is gray), every existing option passed back with its id;
- a field, an option or an issue type whose name differs from the configuration's only
  in case, renamed;
- a missing issue type of `board.issueTypes`, and the description
  `board.issueTypes.descriptions` gives a type;
- the views of `board.github.views`: a missing one created, and the name, layout, filter
  and visible fields of each set as declared (a key a view leaves out is not managed; a
  view it does not name is left alone).

What the API cannot do, or what is risky, it lists under *by hand, in GitHub's UI*, each
with the reason, the settings page and the steps: a view's grouping or a board's columns
that differ from `groupBy` or `columns` (read from the view, set only in the UI), a
field of another type (the API never changes a type), an iteration field (its iterations
are not in the configuration), an
option or a type the configuration lacks (removing it clears it from every item or
issue: the entry says how many hold it, counted from the Project's items or a search of
the organization's issues). A field of `kind: issue` is the organization's, not the
Project's, and is left alone. A field renamed other than by case is not recognised: the
command would create the new name beside the old one, so that rename is done in the UI
first. Run twice, the second run has nothing to change.

It writes through `gh api graphql`, one change at a time, 1.2 s apart (GitHub's
secondary rate limit drops faster writes without a word); the token needs the `project`
scope, and an organization owner to create or rename an issue type. Exit codes: 0 the
plan, or every change applied and read back, or with `--check` a board as declared; 1 a
configuration error, a read or a write `gh` refuses (with the changes applied before
it), a change that does not show on the read-back, or with `--check` a board that
differs (a change or an entry by hand); 2 a usage error.

## CI (`lntt ci`)

Runs a project's CI on the local machine, and moves pull requests through the
candidate branch. ci:local reads the provider's own configuration: GitHub
Actions workflows parsed with `@actions/workflow-parser` (conditions evaluated with
`@actions/expressions`), CircleCI expanded with `circleci config process` and read
with `yaml`. The project's `ci.local` values (cloud-only jobs, fake secrets, actions
mapped to local commands) are read from the configuration above. When to run it and the
secrets policy are the project's CI process description (`docs/process/ci.md`).

```sh
lntt ci local                      # the jobs a ready pull request into the base triggers
lntt ci local --list               # per job: what the cloud runs, what runs locally
lntt ci local --base candidate/3   # the pull request into another base
lntt ci local --event push         # a push to the base
lntt ci local --job ci.yml/ci      # one job (repeatable)
lntt ci local --strict             # fail on anything the cloud runs and the run did not
lntt ci local --container          # each job in act / circleci local execute
lntt ci local --no-lock            # without waiting for the ci:local lock
```

```sh
lntt ci candidate                     # in the candidate workflow: reads the pull_request event
lntt ci candidate --pr 12 --dry-run   # from a terminal: what the workflow would do for #12
```

A project runs the first as `pnpm ci:local`; the second is the candidate automation
(`delivery.candidate`), run by the project's candidate workflow, whose flow is the
delivery process description (`docs/process/delivery.md`). The candidate logic is
adapted from DiscenTech/pelion's `scripts/ci/release-candidate.mjs`. Exit codes: 0 green, 1 a red job or a
configuration error, 2 a usage error.

### What it runs

- **The event.** By default a pull request from the current branch into the base,
  ready for review: the run the cloud starts once a draft leaves draft. The base
  defaults to the branch `origin/HEAD` points at. `--base` names another one; `--event
  push` stands in for a push to the base. Nothing is fetched and GitHub is never asked:
  the base is the local ref (`origin/<base>`, else `<base>`), and the report names it.
- **Which jobs.** A workflow runs when its `on:` takes the event, with its branch,
  types and path filters applied to the local diff. A job's `if:` is evaluated against
  the event: event name, draft, base and head refs, the repository and its default
  branch, the job's env, the fake values. A job with `needs` is decided after them, as
  on GitHub: `success()` when every need passed, `failure()` when one failed,
  `always()`. A condition that reads what only the cloud knows (another job's outputs,
  a label, the actor) is not guessed: the job is reported as not run, with what it
  reads.
- **The steps.** `run:` steps run in order on the host, from the working tree, with
  the env the workflow gives them and `CI=true`. A step without `shell:` runs as
  `bash -e`, without pipefail, as on GitHub; an explicit `shell: bash` adds pipefail,
  and `sh` is supported.
- **Known actions** stand for a local check. `actions/checkout` and the cache actions
  do nothing; `pnpm/action-setup` checks that pnpm is on the PATH; `actions/setup-node`
  checks the host Node against `node-version` or `node-version-file`. Any other action
  fails the run unless `ci.local.actions` maps it, whatever its inputs read.
- **Failures.** After a failed step, only steps that ask for a failure run
  (`if: failure()`, `always()`, CircleCI's `when: on_fail`). A job whose condition is
  false after its needs is skipped; the other jobs go on, so one run lists every red
  job.
- **Not run, reported:** a step whose env or inputs read an undeclared secret,
  matrices, reusable workflows, `services:` (not started), CircleCI background steps.

### Parallel runs and timeouts

- **The lock.** A run (not `--list`, and not a run refused for a dirty tree) takes the
  ci:local lock before its first job and gives it back when it ends, on an interrupt
  too, so runs from parallel worktrees go one at a time instead of starving each
  other's tests. It is a file in `$XDG_CACHE_HOME/lntt` (else `~/.cache/lntt`;
  `$LNTT_CI_LOCK_DIR` names another folder), which must be local to the machine: a
  holder is judged by its pid. `ci.local.lock` sets its scope: `machine` (the default),
  one `ci-local.lock` for every run on the machine, of any project; `project`, one file
  per repository, shared by its worktrees. `--no-lock` runs without it. A lock folder
  that cannot be made or read stops the run with one line, `lntt ci: cannot take the
  ci:local lock (<reason>) — <path>; --no-lock runs without it`, exit 1.
- **Who holds it.** The file holds the owner's record: pid, host (shown, not used to
  judge it), worktree, the moment it took the lock, and the process group of the step
  it is running. A run that finds the lock taken prints, once per holder, `lntt ci:
  waiting for the ci:local lock held by <worktree> (pid <pid> on <host>, since <HH:MM>,
  <N>m ago) — <lock file>`, looks again every 5 seconds, and says how long it waited
  once it has the lock.
- **The maximum hold time.** A holder's run stops 120 minutes after it took the lock:
  the running step is stopped as on a timeout and fails with the machine's load (past
  it between two steps, the next step to start fails so, whatever its kind), the rest
  is skipped with `the run passed the lock's maximum hold time of 120 minutes`,
  and the run exits 1.
- **A stale lock is taken over:** its owner is no longer running and neither is the
  step it recorded, its record is unreadable for more than 10 seconds, or it has been
  held past the maximum hold time and 2 minutes of grace, the holder having failed to
  stop, which the waiter reports naming the holder. An owner killed while its step
  runs leaves that step's process group behind: the waiter says so, `… which is no
  longer running, but its step (process group <N>) still is`, and waits for it.
  Removals happen under a short guard file, `<lock>.takeover`, held by one run at a
  time: its holder removes the lock only if it is still the record judged stale, so a
  lock another run has just taken stays. A guard older than 10 seconds was left by a
  crash and is removed, only while it is still that guard. The owner waits for the
  guard at most 200 ms to record a step's process group, and 2 seconds to give the lock
  back; past that, the lock is left to go stale by its dead pid. A lock that cannot be
  given back is one line on stderr, and the run keeps its exit code.
- **The timeout.** Each step runs in a process group and a session of its own, with no
  controlling terminal, as on a CI runner: a step that prompts on `/dev/tty` (an ssh
  passphrase, a credential prompt, sudo) fails. One that outlasts
  `ci.local.timeoutMinutes` (default 30, at most 1440; in container mode, the whole
  job) gets SIGTERM to its group, then SIGKILL five seconds later, and fails; one that
  ended on its own before the signal is judged by its exit code. The following steps
  go on as after any failure. The report prints next to the step the machine's load,
  read once the step was signalled, `timed out after 30m — load 48.2 / 31.0 / 20.5 on
  15 cores, 9 containers running (7 Testcontainers)` (the containers when Docker
  answers within 3 seconds; `load unavailable` when it cannot be read), and the job
  line names the step. Nothing is retried: a green means every step passed once.
- **An interrupt** (SIGINT, SIGTERM, SIGHUP, SIGQUIT) starts no further step or job,
  stops the running step's group the same way, prints `lntt ci: interrupted (<signal>)`,
  gives the lock back and exits 128 + the signal's number (130, 143, 129, 131), with no
  report.
- **Container mode's limit.** Stopping `act` or `circleci local execute`, on a timeout
  or an interrupt, does not stop the containers they started: they keep running until
  they end or are removed by hand (`docker ps`, `docker rm -f`).

### CircleCI

`circleci config process` expands `.circleci/config.yml` (orbs, commands, parameters).
Which workflows run is decided from the raw file's `when:` against the event's
pipeline values (`pipeline.event.name`, `pipeline.git.branch`,
`pipeline.event.github.pull_request.base.ref`), in expressions and logic maps alike.
The CLI evaluates `when:` without event values, so it processes a copy with every
`when:` removed. A pipeline value the local run does not have makes the workflow not
run, reported.

A dynamic configuration (`setup: true`) is followed to the continuation its chosen
setup workflow names (`config-path` of path-filtering, `configuration_path` of
continuation). The continuation's parameters come from the path-filtering `mapping`,
matched against the files changed since its `base-revision`. Branch filters apply to
the branch the pipeline builds. A job with a `context` is reported as not run unless
cloud-only; project environment variables are not visible in the configuration and
are not detected.

### Container mode

`--container` runs each job whole instead of step by step. For GitHub Actions it uses
`act`, with an event file for the same pull request or push, the fake secrets as `-s`
and the fake vars as `--var`; `act` reads its runner images from `.actrc`
(`-P ubuntu-latest=<image>`). For CircleCI it uses `circleci local execute` on the
processed configuration, with the fake secrets as `-e`. It checks that the executor
and Docker are on the PATH before starting.

### Configuration

```jsonc
"ci": {
  "local": {
    // Jobs that need the cloud, by key: `<workflow file>/<job>`, a whole
    // `<workflow file>`, or `circleci/<job>`.
    "cloudOnly": { "release.yml": "publishes to npm with the release's OIDC token" },
    // Values a check only needs to be present. Tracked: never a real secret.
    "fake": { "secrets": { "CANARY_TOKEN": "not-a-secret" } },
    // Actions ci:local does not know: a command instead, or a skip with its reason.
    "actions": { "actions/upload-artifact": { "skip": "reports stay in the working tree" } },
    // What a run queues behind: every run on the machine, or this repository's (project).
    "lock": "machine",
    // How long one step may run before it is stopped and fails with the machine's load
    // (at most 1440).
    "timeoutMinutes": 30
  }
}
```

```jsonc
"delivery": {
  // Pull requests into main collect on candidate/<N>.
  "candidate": { "base": "main", "prefix": "candidate/", "hotfix": { "prefix": "hotfix/", "label": "hotfix" } }
}
```

### Requirements

The candidate automation needs `gh`, authenticated with a token that has contents,
pull requests and issues on the repository.

To move an issue on the board (`delivery.candidate.status`: `In release` on the squash
into a candidate, `Done` on the candidate's merge) it also needs access to the Project:
the token in `PROJECTS_GH_TOKEN` in the workflow, with the organization permission
Projects, or the login of `gh` with the `project` scope in a terminal
(`gh auth refresh -s project`). Without it the board is left as it is, with a `::notice`.

CircleCI projects need the `circleci` CLI; container mode needs Docker and `act` or the
`circleci` CLI.

## Requirements

Node ≥ 24. A project installs it as a development dependency, with
`@commitlint/config-conventional` as a peer when its commitlint configuration uses
`commitlintConfig`:

```sh
pnpm add -D @lntt/lntt @commitlint/config-conventional
```

The configuration's `$schema` can point at the installed schema,
`node_modules/@lntt/lntt/schema/config.schema.json`. In the starter the package runs
from its sources through the workspace; the published package is compiled to `dist/`.
