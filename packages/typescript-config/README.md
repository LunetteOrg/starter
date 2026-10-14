# @lntt/typescript-config

The TypeScript configs every Lunette project extends. Kept current by version, so a
project raises the package instead of editing a copy.

```sh
pnpm add -D @lntt/typescript-config typescript
```

```jsonc
// tsconfig.json of a Node package or an app's server side
{ "extends": "@lntt/typescript-config/base.json" }

// tsconfig.json of a browser package (React, no emit)
{ "extends": "@lntt/typescript-config/browser.json" }
```

| Config | What it sets |
|---|---|
| `base.json` | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`; ES2024, `module: ESNext` with `moduleResolution: bundler`; `verbatimModuleSyntax`, `isolatedModules`; declarations and source maps |
| `browser.json` | `base.json` plus the DOM libs, `jsx: react-jsx`, `noEmit`, and `allowImportingTsExtensions`, so relative imports carry their real extension (`./x.tsx`) |

A package that emits and wants explicit `.ts` specifiers adds
`allowImportingTsExtensions` and `rewriteRelativeImportExtensions` itself: the first
alone requires `noEmit`.
