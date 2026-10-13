# @lntt/project-config

Reads, validates and edits a Lunette project's configuration: the values skills and
scripts need, in `.agents/config.jsonc` **or** `.agents/config.yml` at the repository
root (one of the two; both is an error). Sections are named after process areas
(`recording` today); [`schema/config.schema.json`](./schema/config.schema.json) says
what each one holds.

Both formats allow comments: a short reason for a value goes next to it. So scripts
never parse the file themselves (`jq` and `JSON.parse` reject comments), and writes go
through an editor that keeps them.

```sh
lntt-config path                       # the file in use
lntt-config validate                   # exit 0 when it matches the schema
lntt-config get recording.logs         # a dotted key, as plain JSON (pipe it to jq)
lntt-config set recording.language '"it"'   # a JSON value, comments kept
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
lntt-config operator                 # the merged profile
lntt-config operator get language    # one key
lntt-config operator sources         # the files it came from
```

Editors validate the file against the schema through its first line:

```jsonc
{ "$schema": "<path or URL of config.schema.json>", … }
```

```yaml
# yaml-language-server: $schema=<path or URL of config.schema.json>
```

The package is private and runs from source on Node ≥ 24 until it is published with
the other shared packages.

## Commit messages

`commitlintConfig()` builds a commitlint configuration from `delivery.commits`
(language, scopes, line length, trailers exempt from it), with rules whose messages say
what to write instead and name the `commit-message` skill:

```js
// commitlint.config.mjs
import { commitlintConfig } from '@lntt/project-config'
export default commitlintConfig()
```

## AGENTS.md

`lntt-config agents sync` writes the managed block of `AGENTS.md` from
[`agents/block.md`](./agents/block.md); `lntt-config agents check` fails when it differs.

## Running the apps locally

`local.apps.<name>` describes each app: base `port`, `url`, `commands` (with `start`),
`env`, `signIn` (a test and/or a document) and seeded `users`, never a password.
`lntt-config local app <name>` resolves it for the current checkout: the main checkout
uses the base port, each linked worktree a stable slot (base + 10 × slot, kept in
`<git common dir>/lunette/ports.json`, freed when the worktree goes), with `{port}`
filled in. The `run-local` skill starts from it.

## Showing a page

```sh
lntt-config viewer detect        # where the session runs, the chosen viewer, why
lntt-config viewer open <url>    # open it there; exit 3 + JSON when only the agent can
```

The choice: the first of the operator's `workspace.viewers` available in this
session, else the app the session runs in (Orca opens in the browser of the same
worktree), else the system browser. Claude desktop (`preview_start`) and Chrome
(`navigate`) are tool calls only the agent can make: `open` prints the call.
