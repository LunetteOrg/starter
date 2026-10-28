# lunette-starter

Monorepo for **`@lntt/create`** — the scaffolder — the **Lunette templates** it ships,
and the shared pieces they use.

```
packages/
  create/
    bin/index.ts        # the CLI
    templates/
      react-router/     # the full Lunette starter (monorepo, Biome, Drizzle, …)
  biome-config/         # @lntt/biome-config: Biome config + GritQL plugins
  typescript-config/    # @lntt/typescript-config: base and browser tsconfigs
  stylelint-config/     # @lntt/stylelint-config
  playwright-config/    # @lntt/playwright-config: definePlaywrightConfig
  test-utils/           # @lntt/test-utils: test Postgres per run, architecture guards
  lntt/                 # the lntt command: .agents/config.*, the operator profile,
                        # lntt check, lntt review, the CI run locally (pnpm ci:local),
                        # and the Lunette plugin for Claude Code (plugin/, with its
                        # marketplace in .claude-plugin/): the review band, issue titles
docs/
  adr/                  # decisions about the templates system
  process/              # how work is done in this repo
.agents/config.jsonc    # this repo's own project configuration
```

## Use

```bash
pnpm create @lntt my-app                 # interactive template pick
pnpm create @lntt my-app --template react-router
```

## The shared skills

The skills every Lunette project uses (`commit-message`, `coordinate`, `decisions`,
`github-board`, `plan-round`, `retrospective`, `review`, `roadmap`, `run-local`) ship
inside `@lntt/lntt`, in [`packages/lntt/skills/`](./packages/lntt/skills/), one version with the `lntt` they
call. In a project, `pnpm exec lntt sync` writes a stub of each into `.agents/skills/`
(Codex, OpenCode, Gemini CLI, Cursor) and `.claude/skills/` (Claude Code), committed;
the stub tells the agent to load the guide with `pnpm exec lntt guide <skill>`, which
prints it from the installed package. A bump of `@lntt/lntt` updates the skills with no
other step; `lntt check skills` says when the stubs need `lntt sync` again (a skill
added, removed or redescribed). The skills read the project's values from
`.agents/config.*` and are never edited to fit a project
([agent layer](./docs/adr/agent-layer.md)).

## The Lunette plugin

The plugin adds to Claude Code the band above the prompt that shows a running `lntt
review` round, `/review-status`, and each issue or pull request number on screen with
its title. It ships inside `@lntt/lntt`, in
[`packages/lntt/plugin/`](./packages/lntt/plugin/), at the package's version. In a
project, `pnpm exec lntt sync` writes into `.claude/settings.json` a `directory`
marketplace pointing at `./node_modules/@lntt/lntt` and enables the plugin from it:
once the folder is trusted, Claude Code loads it in place at every session start, with
no install step, and a bump of `@lntt/lntt` updates it. `lntt check plugin` fails when
those entries are missing or point elsewhere. The path resolves against the main
checkout, so every worktree loads the plugin the main checkout installed; it needs
`node_modules` (the hook `lntt sync` writes beside it installs them at session start),
and cloud sessions do not add such a marketplace
([agent layer](./docs/adr/agent-layer.md#where-hooks-live)).

## Shared packages

What every project must keep current lives in `packages/`, to be published by the
release flow and consumed by version: `@lntt/biome-config`, `@lntt/typescript-config`,
`@lntt/stylelint-config`, `@lntt/playwright-config`, `@lntt/test-utils`, and the
`lntt` command, `@lntt/lntt`. The CLI never rewrites the `@lntt` scope
([scaffolding contract](./docs/adr/scaffolding-contract.md)).
Each package's README says how a project installs and uses it.

## Develop

Node ≥ 24 and pnpm. `pnpm lint`, `pnpm typecheck` and `pnpm test` run every package;
`SCAFFOLD_SMOKE=1 pnpm test` also installs, lints and typechecks a generated project;
`pnpm test:minimal` leaves out the scaffold level (`packages/create`), as the minimal CI does.
The database tests of `@lntt/test-utils` need Docker: without it they skip locally and
fail in CI.
`pnpm ci:local` runs the CI workflows on the working tree before a push
([CI](./docs/process/ci.md)).

- The CLI is TypeScript run directly by Node in this repo and compiled to `dist/` when
  packed ([CLI runtime and publishing](./docs/adr/cli-runtime-and-publishing.md)).
  Its tests scaffold each template into a temp dir and assert the result.
- A template is a folder under `packages/create/templates/`, named by its web
  framework ([template model](./docs/adr/template-model.md)). It is a self-contained
  monorepo, **not** part of this repo's workspace (the root `pnpm-workspace.yaml`
  only globs `packages/*`): to work on one, `cd` into it and `pnpm install`.
- To work on the plugin, load it from the working tree instead of the main checkout's
  copy: `claude --plugin-dir packages/lntt/plugin`, and `/reload-plugins` after an edit.
  `claude plugin validate packages/lntt` checks the marketplace and the plugin.
- Agents read [`AGENTS.md`](./AGENTS.md).
