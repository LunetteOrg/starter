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
  project-config/       # reads .agents/config.* and the operator profile (lntt-config)
plugins/
  lunette/              # the Lunette plugin: skills installed unchanged in every project
.claude-plugin/marketplace.json
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

## The Lunette plugin

The skills every Lunette project uses (`decisions`, `commit-message`) ship as a plugin
from this repository's marketplace:

```
/plugin install lunette --marketplace LunetteOrg/starter      # Claude Code
npx skills add LunetteOrg/starter                             # any other agent
```

They read the project's values from `.agents/config.*` and are never edited to fit a
project. This repo uses its own plugin the same way: `.claude/settings.json` declares
the marketplace and enables the plugin, and each machine installs it once with
`claude plugin install lunette@lunette --scope project`. Claude Code does not install
it by itself in a folder it already trusts.

## Shared packages

What every project must keep current is published from `packages/` and consumed by
version: `@lntt/biome-config`, `@lntt/typescript-config`, `@lntt/stylelint-config`,
`@lntt/playwright-config`. The CLI never rewrites the `@lntt` scope
([scaffolding contract](./docs/adr/scaffolding-contract.md)). Each package's README
says how a project installs and uses it.

## Develop

Node ≥ 24 and pnpm. `pnpm lint`, `pnpm typecheck` and `pnpm test` run every package;
`SCAFFOLD_SMOKE=1 pnpm test` also installs, lints and typechecks a generated project.

- The CLI is TypeScript run directly by Node in this repo and compiled to `dist/` when
  packed ([CLI runtime and publishing](./docs/adr/cli-runtime-and-publishing.md)).
  Its tests scaffold each template into a temp dir and assert the result.
- A template is a folder under `packages/create/templates/`, named by its web
  framework ([template model](./docs/adr/template-model.md)). It is a self-contained
  monorepo, **not** part of this repo's workspace (the root `pnpm-workspace.yaml`
  only globs `packages/*`): to work on one, `cd` into it and `pnpm install`.
- To work on the plugin, load it from the working tree instead of the installed copy:
  `claude --plugin-dir plugins/lunette`, and `/reload-plugins` after an edit.
  `claude plugin validate .` checks the marketplace and the plugin.
- Agents read [`AGENTS.md`](./AGENTS.md).
