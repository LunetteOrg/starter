---
status: accepted
date: 2026-10-14
tags: [cli, publishing, packages, release, versioning, typescript, esm, imports, templates]
---

# CLI runtime and publishing

## Context

`@lntt/create` is written in TypeScript. In this repo Node ≥24 runs
`bin/index.ts` directly through native type stripping, which is stable and on by
default from Node 24.12.0. Two Node rules shape how that code is written and how
it ships:

- **Node refuses to strip types under `node_modules`** and exits with
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. A raw `.ts` bin runs in dev and in
  the tests, and fails when users invoke it through `npm create @lntt` / `npx`.
  Version `0.2.0` shipped that way and is deprecated on npm.
- **Native ESM imposes the file extension in an `import` specifier.** The
  extension is required by Node's resolver, not by TypeScript: extensionless ESM
  resolution does not exist, and no compiler option makes it optional. Node's docs
  write `import './file.ts'`. TypeScript's guidance for Node is `module: nodenext`
  plus `verbatimModuleSyntax`, `erasableSyntaxOnly` and
  `rewriteRelativeImportExtensions`; TS 6.0+ assumes `allowImportingTsExtensions`.

## Decision

### Authored in TypeScript, published as JavaScript

- `bin/index.ts` → `dist/index.js`, built with `tsc -p tsconfig.build.json`
  (`outDir: dist`, `rootDir: bin`; tsc keeps the `#!/usr/bin/env node` shebang).
  `typescript` is already a devDependency.
- `package.json`: `bin` points at `dist/index.js`; `files` ships `dist`, not the
  source; `prepack` runs the build, so `npm pack` and `npm publish` both produce
  the compiled artifact.
- In this repo nothing is built: tests execute `bin/index.ts` directly. Compiling
  is a **publish-time** concern only.
- `TEMPLATES_DIR` resolves as `../../templates` from the bin; `dist/` and `bin/`
  sit at the same depth, so the path is the same in both.
- `test/installed-bin.test.ts` packs, extracts into a real
  `node_modules/@lntt/create`, and runs the published `bin` from there, so the
  install-time failure above fails in CI.
- Publishing happens in CI only, as the next section describes for every package.

### The other `@lntt/*` packages

The packages published from `packages/` besides the CLI follow the same rule.

- **A package whose code Node runs** (`@lntt/playwright-config`, `@lntt/test-utils`,
  `@lntt/lntt`) is authored in TypeScript and published compiled: `tsconfig.build.json`
  emits its sources to `dist/` with declarations, the published `exports` and `bin`
  point at `dist/`, `prepack` builds, `files` ships `dist`. Files its code reads at run
  time ship next to it (`@lntt/lntt` copies `agents/` to `dist/agents`, and the shared skills to `dist/skills`). Its tests
  import the sources, and at least one imports it by name from a `node_modules`, built.
- **A package this repo runs from source through the workspace** (`@lntt/lntt`: the
  root's `lntt`, the git hooks, `commitlint.config.mjs`, the CI workflows) keeps
  `bin` and `exports` on its `.ts` sources and declares the published ones, on
  `dist/`, in `publishConfig`. pnpm applies those overrides when it packs; npm does
  not, so the release packs every package with `pnpm pack` and publishes the tarball
  with `npm publish`.
- **A config package** (`@lntt/biome-config`, `@lntt/typescript-config`,
  `@lntt/stylelint-config`) ships its files as they are, listed in `files` and
  `exports`.
- **The tool a package configures is a peer dependency** (`@biomejs/biome`,
  `typescript`, `stylelint`, `@playwright/test`, `@commitlint/config-conventional`
  for `@lntt/lntt`'s commitlint configuration): the project installs it once, at
  the version it chooses within the range.
- **Tests consume a package by its published name** from a `node_modules`, the way a
  project does. The scaffold smoke installs every published package from its
  tarball into a generated project
  ([scaffolding contract](./scaffolding-contract.md#verified-in-ci)).

### One version for every published package, one release

Every package under `packages/` that is not `private` (`@lntt/create` and the other
`@lntt/*`) carries the same version, and one tag, `vX.Y.Z`, releases them all. A
package with nothing new still gets the new version: the version names a release of
the whole set, which the template depends on as one.

- **The tag is checked against every published package** before anything is
  published (`scripts/packages-version.mts`, which CI also runs on every pull
  request to keep the versions equal).
- **Publishing is CI only**, from `.github/workflows/release.yml`, through npm OIDC
  trusted publishing (`--provenance`, no npm token). A version already on npm is
  skipped, so a failed run can be re-run.
- **A release marked as pre-release is a dry run**: every check runs and nothing
  reaches npm.
- **The one exception: a new package's first publish is by hand**, once, as a
  `0.0.0` placeholder. npm configures a trusted publisher only on a package that
  already exists (npm/cli#8544); the placeholder exists so the first CI release can
  publish the real version through OIDC.

The steps (release, dry run, first publish of a new package) are in
[delivery](../process/delivery.md#releasing).

### Explicit `.ts` extensions for code Node executes

Relative imports in TypeScript that **Node executes directly** carry the explicit
source extension (`./x.ts`, `./x.tsx`): never extensionless, never `.js` pointing
at a `.ts` file.

`packages/create/tsconfig.json` already sets `module`/`moduleResolution:
nodenext`, `verbatimModuleSyntax` and `erasableSyntaxOnly`. When the CLI gets its
first relative import (today it imports only `node:` builtins), it adds the two
options that make the convention work for a package that also **emits**:

- `allowImportingTsExtensions`: permit the `.ts` specifier in source;
- `rewriteRelativeImportExtensions`: rewrite `./x.ts` → `./x.js` when emitting to
  `dist/`, so the compiled artifact resolves under `node_modules`.

Both are needed together: `allowImportingTsExtensions` alone requires `noEmit`.

**Across levels.** This governs the CLI and the packages published from this repo.
Templates are self-contained and decide their own conventions; the `react-router`
template adopts the same explicit extension in its own ADRs, for both its
Node-first domain layer and its bundler-bound UI. What differs is the **runtime, not
the writing convention**: code behind a bundler keeps `moduleResolution: bundler`,
Node-run code uses `nodenext`. There is no shared tsconfig base between the two
levels: this repo's packages do not extend `@lntt/typescript-config`, which is
written for the projects; the divergence is intentional.

## Consequences

### Positive

- The published CLI and packages run where users install them.
- TypeScript authoring and the build-free in-repo loop are kept.
- Import specifiers name the file that exists, aligned with where Node and
  TypeScript are going.

### Negative / accepted risks

- "No build step" holds only in this repo: publishing compiles.
- One more moving part on release (`prepack`). A stale `dist/` cannot leak: it is
  git-ignored and rebuilt on every pack.
- The import convention is inert until the CLI has a relative import.
- Two module-resolution modes coexist across the repo (nodenext for Node-run code,
  bundler for template UI), on purpose.

### When to deviate (revisit triggers)

- Node allows type stripping under `node_modules`: the compile step can go.
- Node or TypeScript change the ESM resolver contract.
- A package here runs *only* behind a bundler: it follows the bundler idiom.
- The packages evolve at very different rates, so that one version bumps packages
  with nothing new often enough to confuse their users: per-package versions
  (changesets) become worth their cost.
- A real pre-release channel is needed: a pre-release then publishes under `next`
  instead of dry-running, and the dry run moves to a manual trigger.

## Discarded directions

- **Publishing the raw `.ts` bin.** It fails under `node_modules`, as above.
- **The configured tool as a regular dependency** of its config package (as the
  template's playwright-config had `@playwright/test`). The project installs the
  tool too, to run it; two declared copies at different versions mean two runners
  (Playwright refuses a second `@playwright/test`) or a config validated against a
  tool the project does not run.
- **`bin` and `exports` on `dist/` in the manifest itself**, for a package the repo
  runs from source. Every in-repo use (the git hooks, commitlint, `pnpm exec lntt`
  in CI) would need a build first, and a stale `dist/` would run instead of the code
  under review.
- **`npm publish` of the package directory.** npm ignores `publishConfig.bin` and
  `publishConfig.exports`, so it would publish the source entries, which fail under
  `node_modules`.
- **A token for the first publish of a new package** (an npm automation token as a
  repository secret, used once by the workflow). It puts a long-lived publish token
  in the repository for a step that happens once per package, and npm still needs
  the package to exist before OIDC replaces it; a placeholder published by hand
  costs one command and leaves no secret behind.
- **A version per package, with changesets.** Each change carries a changeset, a
  release PR collects them, every package moves on its own. It pays off when packages
  evolve at very different rates; here they ship together and the template depends
  on the set, so it adds a file per change and a release PR for no information.
- **Extensionless imports.** The bundler-era idiom; Node's ESM resolver cannot
  resolve them.
- **`.js` specifiers pointing at `.ts` files.** Long the `nodenext` workaround; it
  misleads every reader of the specifier and is obsolete now that TypeScript and
  Node accept the real `.ts` extension, with `rewriteRelativeImportExtensions`
  handling emit.
