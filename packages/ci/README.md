# @lntt/ci

Runs a project's CI on the local machine from the provider's own configuration:
GitHub Actions workflows parsed with `@actions/workflow-parser` (conditions evaluated
with `@actions/expressions`), CircleCI expanded with `circleci config process` and
read with `yaml`. The project's `ci.local` values (cloud-only jobs, fake secrets,
actions mapped to local commands) are read with `@lntt/project-config`.

```sh
lntt-ci local                      # the jobs a ready pull request into the base triggers
lntt-ci local --list               # per job: what the cloud runs, what runs locally
lntt-ci local --base candidate/3   # the pull request into another base
lntt-ci local --event push         # a push to the base
lntt-ci local --job ci.yml/ci      # one job (repeatable)
lntt-ci local --strict             # fail on anything the cloud runs and the run did not
lntt-ci local --container          # each job in act / circleci local execute
```

A project runs it as `pnpm ci:local`. How it decides what to run, what it stands in
for each step with and how secrets are handled is the CI process description
(`docs/process/ci.md` in the starter).

Exit codes: 0 green, 1 a red job or a configuration error, 2 a usage error.

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
`act` or the `circleci` CLI. `act` reads its runner images from `.actrc`
(`-P ubuntu-latest=<image>`).

The package is private and runs from source until it is published with the other
shared packages.
