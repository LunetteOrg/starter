# lunette-starter

Monorepo for **`@lntt/create`** — the scaffolder — and the **Lunette starter
templates** it ships.

```
packages/create/
  bin/index.ts        # the CLI
  templates/
    default/           # the full Lunette starter (monorepo, Biome, Drizzle, …)
```

## Use

```bash
pnpm create @lntt my-app                 # interactive template pick
pnpm create @lntt my-app --template default
```

## Develop

- The CLI is zero-dependency Node; `pnpm --filter @lntt/create test` scaffolds each
  template into a temp dir and asserts the result.
- A template is just a folder under `packages/create/templates/`. To work on the
  default starter, `cd packages/create/templates/default && pnpm install` — it is a
  self-contained monorepo and is intentionally **not** part of this repo's
  workspace (the root `pnpm-workspace.yaml` only globs `packages/*`).
- Templates carry a `.lunette-template` marker; the CLI strips it on scaffold, so
  its presence means "you're editing the template", its absence means "scaffolded
  project" (see the template's own `docs/adr/0001-recording-decisions.md`).
