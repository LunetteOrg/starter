# CI: how the starter checks a change

The cloud CI is GitHub Actions (`.github/workflows/`). The same checks run on the
author's machine with `pnpm ci:local`, which reads those workflow files and runs
their steps; there is no second list of commands to keep in step with them. The
values ci:local needs beyond the workflows are in `ci.local` of
[`.agents/config.jsonc`](../../.agents/config.jsonc).

## `pnpm ci:local`

`pnpm ci:local` (the `lntt-ci local` command of [`@lntt/ci`](../../packages/ci/README.md))
stands in for the event the cloud would see, and runs the jobs that event triggers:

- **The event.** By default a pull request from the current branch into the base,
  ready for review: the run the cloud starts once a draft leaves draft. `--base`
  names another base; `--event push` stands in for a push to the base, which is
  what gates a release. ci:local never fetches and never asks GitHub: the base is
  the local ref (`origin/<base>`, else `<base>`), and the report names it.
- **Which jobs.** A workflow runs when its `on:` takes the event, with its branch,
  types and path filters applied to the local diff. A job's `if:` is evaluated
  against the event (event name, draft, base and head refs, the job's env, the fake
  values below). A condition that reads what only the cloud knows (another job's
  outputs, a label, the actor) is not guessed: the job is reported as not run, with
  what the condition reads.
- **The steps.** `run:` steps run in order on the host, from the working tree, with
  the env the workflow gives them and `CI=true`. Known `uses:` stand for a local
  check: `actions/checkout` and the cache actions do nothing, `pnpm/action-setup`
  checks that pnpm is on the PATH, `actions/setup-node` checks the host Node against
  `.nvmrc`. **Any other action fails the run**, so a new action in a workflow forces
  a decision: map it in `ci.local.actions` (a command, or a skip with its reason),
  or declare its job cloud-only. After a failed step only steps that ask for a
  failure run, as in the cloud; a job whose need failed is skipped, and the other
  jobs go on, so one run lists every red job.
- **A clean tree.** The run refuses uncommitted changes: it checks the commit about
  to be pushed. `--list` runs nothing and works on any tree.

`pnpm ci:local --list` prints, per job, what the cloud runs and what the local run
does in its place, and why a job is not run. `--job <key>` runs one job.

### Secrets

No real secret runs locally, and ci:local never reads one from a password manager.

- **Jobs that need the cloud** (publishing, a release, a deploy gate, a hosted
  service) are named in `ci.local.cloudOnly` with the reason, and the report shows
  them as cloud only.
- **Canary values**, which a step only needs to be present, are declared in
  `ci.local.fake` (`secrets`, `vars`). They are tracked: never a real value.
- **Any other secret** a step reads makes that step not run, and the report names
  the secret. The run stays green; `--strict` makes it fail instead, for a run that
  must prove the whole job.

### What differs from the cloud, declared

- The run uses the host's tools and services: a job's `services:` (or CircleCI's
  secondary images) are not started, and the report says so. Tests that need a
  database start their own (Testcontainers).
- ci:local sets `CI=true` but not `GITHUB_ACTIONS` or `CIRCLECI`: a step that only
  makes sense on a cloud runner (installing system packages, `sudo`) can test those
  and do nothing locally.
- Matrices and reusable workflows are reported as not run.

### CircleCI

A project on CircleCI gets the same run: `circleci config process` expands
`.circleci/config.yml` (orbs, commands, parameters), and ci:local picks the
workflows from their `when:` against the event, which the CLI cannot do because it
has no event values. A dynamic configuration (`setup: true`) is followed to the
continuation its setup workflow chooses, with the parameters its path-filtering
`mapping` sets from the local diff. A job with a `context` is not run unless it is
cloud-only: a context holds secrets, and which variables a step reads is not
written in the configuration.

### Container mode

`--container` runs each job whole in the provider's own local executor instead of
on the host: `act` for GitHub Actions (with an event file for the same pull request
or push, and the fake values as `-s`/`--var`), `circleci local execute` for
CircleCI (the processed configuration, the fake secrets as `-e`). Both were tried
on a one-step job on macOS with Docker Desktop. It is slower and differs from the
cloud in its own ways (act's images are not GitHub's runners; `circleci local
execute` runs one job, without workflows, caches or workspaces), so native mode is
the default.

## Discarded directions

- **A script that restates the CI's commands** (wai's `scripts/ci-local.sh`), or job
  steps moved into scripts both sides call (pelion). The first drifts as soon as a
  step changes in the YAML; the second still lets the two environments drift, and
  a step added to the YAML outside the scripts is missed.
- **A check that compares the cloud's plan with a local list.** Reading the
  configuration and running it removes the list to compare with.
- **Container mode as the default.** Gigabytes of images, a different runner than
  the cloud's, and none of the machine's caches, for a run whose job is to answer
  quickly on a draft.
- **Real secrets from 1Password (or another manager) in local runs.** A local run
  would then reach the services the secrets open, and a check that passes only with
  a real secret belongs to the cloud, where the secret lives.
- **A pre-push hook running ci:local.** Too slow for the push it guards, skipped with
  `--no-verify`, and it would block the pushes that save work in progress.
