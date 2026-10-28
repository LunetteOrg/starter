# Architecture Decision Records — the Lunette starter

Decisions about the **templates system** — `@lntt/create` and how templates are
defined, organized, and scaffolded. A single template's *own* application
architecture is recorded inside that template (e.g.
`packages/create/templates/react-router/docs/adr/`), not here. The rules for
writing a record are the `decisions` skill's; what is particular to this repo is in
[recording](../process/recording.md). How the repo works (process, not technical
decisions) is in [`docs/process/`](../process/README.md).

| ADR | Subject | Status |
|---|---|---|
| [template-model](./template-model.md) | What a Lunette template is; templates as folders bundled inside the CLI | accepted |
| [scaffolding-contract](./scaffolding-contract.md) | Placeholders, the `@lntt/*` scope, dotfiles and text-file coverage every template honours | accepted |
| [cli-runtime-and-publishing](./cli-runtime-and-publishing.md) | The CLI and the `@lntt/*` packages run as TypeScript in-repo and ship compiled; one shared version and release; explicit `.ts` imports | accepted |
| [test-database](./test-database.md) | `@lntt/test-utils`: one Postgres per vitest run, owned by a globalSetup; Ryuk on; required `databaseName`; container rules; cleanup by label | accepted |
| [e2e-helpers](./e2e-helpers.md) | `@lntt/test-utils/playwright`: `test` with hydration delayed on demand, `repeatUntil`, `expectFetchMetadata`, the lint plugin; `./e2e-port`, a stable port per checkout apart from `lntt`'s slots | accepted |
| [agent-layer](./agent-layer.md) | Installed skills are never edited; their guides come with `lntt`, a project holds stubs; project values in `.agents/config.*`; operator context; issue titles on screen | accepted |
| [lntt-command](./lntt-command.md) | One package, `@lntt/lntt`, with one command, `lntt`, for configuration, agent files, branches, worktrees, the board and CI; its gates and agent tools, and the configuration's compatibility rule | accepted |
| [review-agents](./review-agents.md) | Reviews by agents with no context, per-project lenses, agents and models; adversarial verification; `lntt review` | accepted |
| [test-guards](./test-guards.md) | `@lntt/test-utils` guards of a project's test suite: module mocks, waits, Biome domains and lint warnings, the tx fixture, test projects as dependencies | accepted |
| [test-checks](./test-checks.md) | `lntt check tests`: the test levels, `focus`, `rules`, `touched`, and the mutations the author and the reviewer run with `lntt`, the `mutation-check` skill | accepted |
| [vitest-preset](./vitest-preset.md) | `@lntt/test-utils/vitest`: `sharedTest()`, `appTest()` with a `fast` project under `isolate: false`; the jsdom setup listed in `setupFiles`, its stubs and teardown, and what still leaks | accepted |
| [worktree-tooling](./worktree-tooling.md) | Branch names, setup, brief and agent launch decided in `lntt`; Orca, Herdr and git as adapters | accepted |
| [coordinator-mode](./coordinator-mode.md) | A theme's coordinator worktree delegates each issue to a child and writes no code; the gate, the model per role and the mailbox (`lntt ask`) | accepted |

A new subject gets its own file: copy [`template.md`](./template.md) to
`<subject>.md` and add a row above. A changed decision is rewritten in its file.
