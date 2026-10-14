# @lntt/stylelint-config

The Stylelint config every Lunette project extends. Kept current by version, so a
project raises the package instead of editing a copy.

```sh
pnpm add -D -w @lntt/stylelint-config stylelint
```

```json
// .stylelintrc.json
{ "extends": ["@lntt/stylelint-config"] }
```

- `stylelint-config-standard` and `stylelint-config-css-modules`: modern CSS rules and
  the `*.module.css` syntax (`:global`, `composes`).
- `stylelint-no-unsupported-browser-features` as a **warning**, over the project's
  `browserslist`; `css-nesting` is ignored.
- Class names in camelCase, the CSS Modules convention.
- Media queries in the prefix form (`min-width`), not the range form.

Biome formats and lints CSS at a basic level; this config adds what Biome does not
cover.
