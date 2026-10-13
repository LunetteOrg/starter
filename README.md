# lunette-starter

Monorepo for **`@lntt/create`** — the scaffolder — and the **Lunette starter
templates** it ships.

```
packages/create/
  bin/index.ts        # the CLI
  templates/
    react-router/      # the full Lunette starter (monorepo, Biome, Drizzle, …)
```

## Use

```bash
pnpm create @lntt my-app                 # interactive template pick
pnpm create @lntt my-app --template react-router
```

## Develop

- The CLI is zero-dependency Node; `pnpm --filter @lntt/create test` scaffolds each
  template into a temp dir and asserts the result.
- A template is just a folder under `packages/create/templates/`. To work on the
  default starter, `cd packages/create/templates/react-router && pnpm install` — it is a
  self-contained monorepo and is intentionally **not** part of this repo's
  workspace (the root `pnpm-workspace.yaml` only globs `packages/*`).
- A template's own ADRs and PDRs, like this repo's, are one file per subject,
  corrected in place — see `CLAUDE.md` and [recording](./docs/process/recording.md).
