# CI: how the starter checks a change

The cloud CI is GitHub Actions (`.github/workflows/`). The same checks run on the
author's machine with `pnpm ci:local`, which reads those workflow files and runs their
steps: there is no second list of commands to keep in step with them. How it reads
them and what it stands in for each step with is the tool's own documentation
([`lntt ci`](../../packages/lntt/README.md#ci-lntt-ci)); this page holds the rules the
team works by. The values are `ci.local` in [`.agents/config.jsonc`](../../.agents/config.jsonc).

## What runs where

Every cloud run costs minutes, and GitHub bills each job rounded up to the minute. The
CI runs where a machine other than the author's can catch something, and once per
batch for what is expensive ([delivery](./delivery.md) has the flow):

| Event | What runs |
|---|---|
| A draft, into any base | nothing in the cloud; `pnpm ci:local` on the machine |
| A ready pull request into a candidate, or into any branch other than `main` (a stacked pull request) | the minimal CI: frozen install, lint, typecheck, `lntt check` (the AGENTS.md block, the installed skills, the decision logs), the branch name, the plugin version and `claude plugin validate`, the tests but the scaffold level, unless the change touches `packages/create`; the retrospective block of the body, as a warning (not on a Dependabot pull request) |
| The candidate's pull request into `main`, ready; a hotfix | the full CI: the minimal CI plus the scaffold level (`packages/create`) and its smoke; the body's retrospective block only on a hotfix (the candidate's block is its retrospective comment, which `lntt check body --pr <n>` checks before the candidate is marked ready, [delivery](./delivery.md#the-candidate)) |
| A push to `main` | the full CI, which gates a release |
| A Dependabot pull request | the `ci` check red in seconds, until an owner, member or collaborator approves it; the approval runs the CI the base calls for, and a later push turns it red again ([Dependabot pull requests](#dependabot-pull-requests)) |
| A merge into a candidate | nothing |
| Every day (the `schedule` of `upstream.yml`), or by hand (`workflow_dispatch`) | the [upstream check](#upstream-tools) of each new release of Orca, Herdr, claude and opencode |

`ci.yml` is one job, so each run is billed once. The job is skipped on a draft, and
`ready_for_review` starts it when the draft leaves draft. The tests run on every run:
`pnpm ci:local` runs them on the author's machine, and a failure that shows only on the
CI's Linux runner (a test that depends on timing, a path, a tool) would otherwise reach
the candidate first. The scaffold level is the exception (`packages/create`: a project
generated and committed with git, the package packed with npm, and the smoke that
installs, lints and typechecks a generated project). It is slow and depends on the
machine (a git process the scaffold leaves behind, a loaded laptop), so a red there says
little about a change elsewhere: on a pull request into a candidate it runs only when
the change touches `packages/create`, and the full CI runs it always, when the base is
the default branch or the event is a push. A scaffold failure that a pull request does
not see is caught on the candidate, and fixed forward there. The candidate automation
(`candidate.yml`) is not CI: it runs on its own three events, drafts included
([delivery](./delivery.md#the-candidate-automation)).

## When to run it

- **Before a push leaves the machine for review**: `pnpm ci:local` green on the head
  about to be pushed. It refuses uncommitted changes, so the run is about that head.
  Its default base is `main`, so it runs the full CI, a superset of the minimal one;
  `--base <candidate> --list` shows what the minimal CI runs (the test step's choice,
  scaffold level or not, is made when it runs, from the diff against the base).
- **On the candidate, before it is marked ready** ([delivery](./delivery.md#the-candidate)).
- **`pnpm ci:local --list`** before changing a workflow: it shows, per job, what the
  cloud runs and what the local run does instead.
- **`--strict`** when the run must prove the whole of every job: anything the cloud
  runs and the local run did not (an undeclared secret, a condition only the cloud can
  evaluate) fails it.

A red run is fixed before the push, like a red CI.

## Parallel worktrees

Runs from parallel worktrees queue on the ci:local lock: by default one at a time on
the machine, whoever started them, a coordinator's children and a run started by hand
alike. A project that queues only its own runs sets `ci.local.lock`
([`lntt ci`](../../packages/lntt/README.md#parallel-runs-and-timeouts)).
`--no-lock` is the one exception, for a run that must not wait. A run stops at the
lock's maximum hold time, and a step stops at `ci.local.timeoutMinutes`
([`lntt ci`](../../packages/lntt/README.md#parallel-runs-and-timeouts)). A step
that outlasts its timeout fails with the machine's load printed next to it. A timeout
red with a high load, or with the load unavailable, is rerun once the machine is idle,
and the pull request waits for that green: a red run is never explained away in its
body.

## Secrets

No real secret runs locally, and ci:local never reads one from a password manager.

- **Jobs that need the cloud** (publishing, a release, a deploy gate, a hosted
  service) are named in `ci.local.cloudOnly` with the reason, and the report shows
  them as cloud only.
- **Canary values**, which a step only needs to be present, are declared in
  `ci.local.fake`. The file is tracked: never a real value.
- **Any other secret** a step reads makes that step not run, and the report names it.
  The run stays green; `--strict` fails it.
- **On CircleCI** a job with a `context` is not run unless it is cloud-only, since a
  context holds secrets. Project environment variables are not detected: a step that
  reads one runs without it, and fails or passes on its own. A job that needs them is
  declared cloud-only.

## Writing a workflow

- **A new action is a decision.** An action ci:local does not know fails the run until
  it is mapped in `ci.local.actions` (a local command, or a skip with its reason) or
  its job is declared cloud-only.
- **Steps that only make sense on a cloud runner** (installing system packages, `sudo`)
  test `GITHUB_ACTIONS` or `CIRCLECI`: ci:local sets `CI=true` and neither of those.
- **Steps run with no controlling terminal**, as on a CI runner: a step that prompts on
  `/dev/tty` fails ([`lntt ci`](../../packages/lntt/README.md#parallel-runs-and-timeouts)).
- A job's `services:` are not started locally: tests that need a database start their
  own (Testcontainers).

## CircleCI needs the network

On a CircleCI project, `ci:local` expands the configuration with `circleci config
process`, which sends it to CircleCI's server: it needs the network, also for a dynamic
configuration's continuation. Public orbs need no login; a private orb needs a valid
one. A stored login that has expired or was revoked makes the CLI stop with "The API
token was rejected by CircleCI", and `lntt` reports that the stored login is not valid:
`circleci auth logout` (the anonymous call works for public orbs) or log in again. The
CLI runs from the repository root, where a `mise.toml` pins its version.

## Container mode

`pnpm ci:local --container` runs each job whole in `act` (GitHub Actions) or
`circleci local execute` (CircleCI) instead of on the host. It is optional, and the
default stays native: it needs Docker and gigabytes of images, and its runner images
are not the cloud's. A timeout or an interrupt stops the executor, not the containers
it started ([`lntt ci`](../../packages/lntt/README.md#parallel-runs-and-timeouts)).

Known to work, on macOS with Docker Desktop: a one-step job in each executor, with a
fake secret. A full job needs a runner image that has what its steps call (`git` for
`pnpm test` here), which the slim images lack. **Unproven:** a full job green in either
executor, the larger `act` images, a job with services, a dynamic CircleCI
configuration.

## Dependabot pull requests

Dependabot's pull requests stay on `main` and merge as hotfixes, when a person decides
([delivery](./delivery.md#the-candidate)): the candidate automation cannot move them.

- **The CI runs once an owner, member or collaborator approves.** Dependabot rebases its
  pull requests often, and each rebase would start a full CI on a head nobody merges.
  Until an owner, member or collaborator approves, the `ci` job fails in its first
  step, before checkout and install, with "Approve this Dependabot pull request to run
  the CI before merging": red, never skipped, since a skipped job counts as passed. The
  repository is public, so anyone can submit a review: an approval from anyone else
  fails like the unapproved run.
- **Every review starts a run.** An approval runs the whole job on the pull request's
  merge ref; a comment or a request for changes fails in the first step, like the
  unapproved run. The newest `ci` run of a Dependabot head is therefore either red or
  the whole job. A new push (a Dependabot rebase) turns it red again, and only a new
  approval runs it: re-running a red run fails again, since its event is unchanged. A
  comment or a request for changes after the approval turns it red as well, until the
  next approval. The earlier approval stays on the pull request, so a red `ci` beside
  an approval means a head or a review the CI has not run on.
- **The approval runs the bump's code** (install, lint, tests, the scaffold smoke) on
  the repository's runner. The run is started by the reviewer, not by Dependabot, so it
  is not restricted like Dependabot's own runs: `ci.yml` reads no secret, and its
  `GITHUB_TOKEN` can only read the contents, on every run, since no job writes.
  Approving is the review of the bump.
- **A review of any other pull request** starts a run whose job is skipped. It is an
  entry of its own in the pull request's checks, `CI / ci (pull_request_review)`, beside
  the `CI / ci (pull_request)` it does not replace.
- **The merge reads the newest `ci` run** of the head. `ci` is not a required status
  check in the repository's rulesets: an approved Dependabot pull request carries the
  red run of its push and the run of its approval, as two entries of the checks, and a
  required `ci` would need this section decided again.
- **ci:local does not simulate a review**: it runs the pull request or the push. The
  approval run is the cloud's.
- A Dependabot pull request moved onto a candidate keeps the gate, and its approval
  runs the minimal CI, as for any pull request into a candidate.

## Upstream tools

lntt drives tools it does not own, and its own tests run against fakes of them.
`upstream.yml` reads the latest release of each one every day and checks lntt against
each version it has not checked yet, in a job of its own on a throwaway runner:
`scripts/upstream-install.sh` installs it, and `pnpm --filter @lntt/lntt test:upstream`
runs `packages/lntt/test/upstream-<tool>.test.ts` with `UPSTREAM_SMOKE=<tool>` (the tests
skip without it). The script installs system packages and refuses a release asset whose
sha256 GitHub does not record, so it runs only on a throwaway machine: a GitHub runner,
or a container to try a change to it.

| Tool | Where its version comes from | What the test checks |
|---|---|---|
| Orca | GitHub Releases of `stablyai/orca` (the `.deb`) | the flags lntt passes, against `orca agent-context --json`; on a headless `orca serve`, `startOrca` with the real `claude` not logged in (path, handle, model, effort, brief) and with opencode's shell launch, and the review's subagents through Orca's hook script |
| Herdr | GitHub Releases of `herdrdev/herdr` | the flags, against each subcommand's `--help`; on a headless `herdr server`, `startHerdr` through `agent start` and through the shell command Herdr detects |
| claude | npm `@anthropic-ai/claude-code` | the flags, against `claude --help`; a one-line call on `haiku` whose JSON lntt parses, authenticated by Workload Identity Federation: the repository variables `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID` and `ANTHROPIC_WORKSPACE_ID` and the job's GitHub OIDC token, with no stored key; without the variables, that call is skipped with a notice |
| opencode | Homebrew's `opencode` formula | the flags, against `opencode run --help` and `opencode --help`; a one-line call on a free model whose JSON lntt parses |

A version counts as checked once its cache entry `upstream-<tool>-<version>` exists, which
the job saves green or red, unless the issue of a red could not be opened: that version is
checked again the next day. GitHub evicts an entry left unused (its cache retention); the version
is then checked again, and its issue, if any, stops a second one. `workflow_dispatch` takes
one tool and `force`, to check a version again; it is run from `main`, whose cache the
scheduled runs use.

A red opens the issue `<tool> <version> breaks lntt`, once per tool and version, with the
failing step, the run and the end of the log. Whoever takes it reads the log, then fixes
lntt's adapter (`packages/lntt/src/worktree.ts`, `headless.ts`, `orca-subagents.ts`) or
records the tool's change in the decision that relies on it
([worktree tooling](../adr/worktree-tooling.md), [review agents](../adr/review-agents.md)).
When Homebrew installs another opencode than the one the versions job read, the job
checks the one installed, under its own version, and saves an entry for both. A red that is the
runner's (a download that failed) closes the issue and runs the
workflow again with that tool and `force`, which checks the tool's latest version; that
run opens no second issue, so its outcome is read in the run. A job that outlasts its
timeout opens no issue and saves no entry: the version is checked again the next day, and
its red runs are the signal.

## Discarded directions

- **One workflow per upstream tool.** The install, the issue and the cache steps would be
  written four times; a matrix job per tool keeps each tool's log, red and issue apart.
- **The checked versions in a file of the repository.** The workflow would push to
  `main` every day, and a person's commit would race it; a cache entry costs nothing to
  write and is lost only to a check run again.
- **A script that restates the CI's commands** (wai's `scripts/ci-local.sh`), or job
  steps moved into scripts both sides call (pelion). The first drifts as soon as a
  step changes in the YAML; the second still lets the two environments drift, and a
  step added to the YAML outside the scripts is missed.
- **A check that compares the cloud's plan with a local list.** Reading the
  configuration and running it removes the list to compare with.
- **Container mode as the default.** Gigabytes of images, a different runner than the
  cloud's, and none of the machine's caches, for a run whose job is to answer quickly.
- **Real secrets from 1Password (or another manager) in local runs.** A local run would
  then reach the services the secrets open, and a check that passes only with a real
  secret belongs to the cloud, where the secret lives.
- **A pre-push hook running ci:local.** Too slow for the push it guards, skipped with
  `--no-verify`, and it would block the pushes that save work in progress.
- **`concurrency: cancel-in-progress` as the saving.** It cancels only runs still in
  progress, and review rounds are minutes apart; the saving comes from not pushing
  drafts.
- **The full CI on every pull request into the candidate.** The candidate runs the
  scaffold smoke on the whole batch; on each pull request it would install a generated
  project twice for the same check.
- **A lock held by the orchestration layer** (the coordinator's brief). It misses the
  runs started by hand, and the load it guards against crosses projects, which no
  project's coordinator sees.
- **A retry of a failed step inside ci:local**, even for a known infrastructure flake.
  A gate's green must mean the commit passed; a flaky test is the test runner's to
  report.
- **No tests on a pull request into the candidate.** They would run only on the
  author's machine, which is not the CI's: a test that depends on timing can pass there
  and fail on the Linux runner, and the candidate would be the first to see it.
- **The scaffold level on every pull request into the candidate.** On a loaded machine
  it fails for reasons outside the change (a git process the scaffold leaves behind),
  and `ci:local` runs the same step: one such red blocks every pull request at once,
  most of which do not touch `packages/create`.
- **A `run-ci` label that starts the CI on a Dependabot pull request.** A `labeled`
  trigger cannot filter by the label's name, so every label on every pull request
  starts a run whose job is skipped; that skipped run is a `pull_request` run too, so it
  takes the place of the red `ci (pull_request)` entry and can hide it.
- **Moving each Dependabot pull request onto the candidate by hand.** One command per
  pull request, on a bot that opens them in waves and rebases them on its own; the
  command stays available for the one that belongs in a batch.
- **A merge queue (`merge_group`).** It runs the CI on what would be merged, but it
  works through required checks, which the repository does not set, and it puts every
  pull request through the queue, not only Dependabot's.
- **A concurrency group on `ci.yml`.** Review runs would share it with the pull
  request's own runs, so a review of any pull request could cancel or queue its real
  run; the unapproved run of a Dependabot pull request ends in seconds anyway.
