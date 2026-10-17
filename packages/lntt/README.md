# @lntt/lntt

The `lntt` command, for the people and the agents of a Lunette project: its
configuration and the operator profile, the managed block of `AGENTS.md`, the checks and
the review of a change, branch names, the apps run locally, and its CI run on the local
machine with the candidate automation ([`lntt ci`](#ci-lntt-ci)).

## The configuration

Reads, validates and edits a Lunette project's configuration: the values skills and
scripts need, in `.agents/config.jsonc` **or** `.agents/config.yml` at the repository
root (one of the two; both is an error). Sections are named after process areas
(`recording` today); [`schema/config.schema.json`](./schema/config.schema.json) says
what each one holds.

Both formats allow comments: a short reason for a value goes next to it. So scripts
never parse the file themselves (`jq` and `JSON.parse` reject comments), and writes go
through an editor that keeps them.

```sh
lntt path                       # the file in use
lntt validate                   # exit 0 when it matches the schema
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

## AGENTS.md

`lntt sync` writes the managed block of `AGENTS.md` from
[`agents/block.md`](./agents/block.md); `lntt check agents-md` fails when it differs.

## Checks (`lntt check`)

What is checked without judgement, one area per review lens, so a reviewer reads the
result instead of redoing it by eye.

```sh
lntt check                                              # every area: what CI runs
lntt check agents-md                                    # the managed block of AGENTS.md
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

## Reviewing a change

```sh
lntt review                       # one round on the current branch; JSON on stdout
lntt review --base <branch>       # against another base (a stacked pull request)
lntt review --plan                # the range, the lenses and their agents; runs nothing
lntt review reply f2 "line 120 excludes it"   # answer the reviewers who found f2
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
    "actions": { "actions/upload-artifact": { "skip": "reports stay in the working tree" } }
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

The candidate automation needs `gh`, authenticated with a token that has
contents, pull requests and issues on the repository. CircleCI projects need the `circleci` CLI; container mode needs Docker and `act`
or the `circleci` CLI.

## Requirements

Node ≥ 24. The package is private and runs from source until it is published with the
other shared packages.
