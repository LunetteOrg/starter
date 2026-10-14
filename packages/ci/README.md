# @lntt/ci

Runs a project's CI on the local machine from the provider's own configuration: GitHub
Actions workflows parsed with `@actions/workflow-parser` (conditions evaluated with
`@actions/expressions`), CircleCI expanded with `circleci config process` and read
with `yaml`. The project's `ci.local` values (cloud-only jobs, fake secrets, actions
mapped to local commands) are read with `@lntt/project-config`. When to run it and the
secrets policy are the project's CI process description (`docs/process/ci.md`).

```sh
lntt-ci local                      # the jobs a ready pull request into the base triggers
lntt-ci local --list               # per job: what the cloud runs, what runs locally
lntt-ci local --base candidate/3   # the pull request into another base
lntt-ci local --event push         # a push to the base
lntt-ci local --job ci.yml/ci      # one job (repeatable)
lntt-ci local --strict             # fail on anything the cloud runs and the run did not
lntt-ci local --container          # each job in act / circleci local execute
```

A project runs it as `pnpm ci:local`. Exit codes: 0 green, 1 a red job or a
configuration error, 2 a usage error.

## What it runs

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

## CircleCI

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

## Container mode

`--container` runs each job whole instead of step by step. For GitHub Actions it uses
`act`, with an event file for the same pull request or push, the fake secrets as `-s`
and the fake vars as `--var`; `act` reads its runner images from `.actrc`
(`-P ubuntu-latest=<image>`). For CircleCI it uses `circleci local execute` on the
processed configuration, with the fake secrets as `-e`. It checks that the executor
and Docker are on the PATH before starting.

## Configuration

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

## Requirements

Node ≥ 24. CircleCI projects need the `circleci` CLI; container mode needs Docker and
`act` or the `circleci` CLI.

The package is private and runs from source until it is published with the other
shared packages.
