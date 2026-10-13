# lunette-starter

Monorepo for **`@lntt/create`** — the scaffolder — the **Lunette templates** it ships,
and the shared pieces they use.

```
packages/
  create/
    bin/index.ts        # the CLI
    templates/
      react-router/     # the full Lunette starter (monorepo, Biome, Drizzle, …)
  project-config/       # reads .agents/config.* and the operator profile (lntt-config)
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
- Agents read [`AGENTS.md`](./AGENTS.md).
