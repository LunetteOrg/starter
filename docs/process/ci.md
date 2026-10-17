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
| A ready pull request into a candidate, or into any branch other than `main` (a stacked pull request) | the minimal CI: frozen install, lint, typecheck, the AGENTS.md block, the branch name, the plugin version |
| The candidate's pull request into `main`, ready; a hotfix | the full CI: the minimal CI plus the tests and the scaffold smoke |
| A push to `main` | the full CI, which gates a release |
| A merge into a candidate | nothing |

`ci.yml` is one job, so each run is billed once. The job is skipped on a draft, and
`ready_for_review` starts it when the draft leaves draft. The tests and the smoke run
when the base is the default branch or the event is a push. The candidate automation
(`candidate.yml`) is not CI: it runs on its own three events, drafts included
([delivery](./delivery.md#the-candidate-automation)).

## When to run it

- **Before a push leaves the machine for review**: `pnpm ci:local` green on the head
  about to be pushed. It refuses uncommitted changes, so the run is about that head.
  Its default base is `main`, so it runs the full CI, a superset of the minimal one;
  `--base <candidate> --list` shows what the minimal CI runs.
- **On the candidate, before it is marked ready** ([delivery](./delivery.md#the-candidate)).
- **`pnpm ci:local --list`** before changing a workflow: it shows, per job, what the
  cloud runs and what the local run does instead.
- **`--strict`** when the run must prove the whole of every job: anything the cloud
  runs and the local run did not (an undeclared secret, a condition only the cloud can
  evaluate) fails it.

A red run is fixed before the push, like a red CI.

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
- A job's `services:` are not started locally: tests that need a database start their
  own (Testcontainers).

## Container mode

`pnpm ci:local --container` runs each job whole in `act` (GitHub Actions) or
`circleci local execute` (CircleCI) instead of on the host. It is optional, and the
default stays native: it needs Docker and gigabytes of images, and its runner images
are not the cloud's.

Tried, on macOS with Docker Desktop: a one-step job in each executor, with a fake
secret; and this repository's `ci.yml` in `act` with `node:24-bookworm-slim`, green up
to `pnpm test`, which failed because that image has no `git`. **Not tried:** a full
job green in either executor, the larger `act` images, a job with services, a dynamic
CircleCI configuration.

## Discarded directions

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
- **The full CI on every pull request into the candidate.** The candidate runs it on
  the whole batch; on each pull request it would pay twice for the same checks.
