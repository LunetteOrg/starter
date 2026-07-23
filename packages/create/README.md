# @lntt/create

Scaffold a new project from a Lunette starter template.

```bash
pnpm create @lntt my-app                      # interactive template pick
pnpm create @lntt my-app --template react-router
```

or with npm / npx:

```bash
npm  create @lntt@latest my-app
npx  @lntt/create my-app --template react-router
```

## What it does

Copies the chosen template verbatim into `my-app/`, then:

- restores npm-mangled dotfiles (`_gitignore` → `.gitignore`, `_npmrc` → `.npmrc`, `_env` → `.env`);
- rewrites the `@starter/*` scope and `starter` credentials to your project name.

## Templates

- **`react-router`** _(default)_ — the current Lunette starter.

Pass `--template <name>` (alias `-t`) to pick one, or omit it for the
interactive prompt.

## Requirements

- **Node ≥ 24** — the CLI runs directly via native type stripping, no build step.

## License

[MIT](./LICENSE)
