# ADR-0005: Ship the CLI as compiled JavaScript

- Status: accepted
- Date: 2026-07-08

## Context

`@lntt/create` is written as a single TypeScript file, `bin/index.ts`, and Node
≥24 runs it directly via native type stripping — no build step. That holds *in
this repo*, where the file is executed from a normal path. It does **not** hold
once the package is installed: Node refuses to strip types for any file under
`node_modules` and exits with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. So a
raw `.ts` bin runs in dev and in the tests, but is dead on arrival via
`npm create @lntt` / `npx` — exactly how users invoke it. Version `0.2.0` shipped
this way and was broken; it is deprecated on npm.

The test that packed the tarball ran the bin from a plain temp dir, not from a
`node_modules` tree, so it never reproduced the install-time failure.

## Decision

Keep authoring the CLI in TypeScript, but **publish compiled JavaScript**.

- `bin/index.ts` → `dist/index.js`, built with `tsc -p tsconfig.build.json`
  (`outDir: dist`, `rootDir: bin`; tsc preserves the `#!/usr/bin/env node`
  shebang). No new dependency — `typescript` is already a devDep.
- `package.json`: `bin` points at `dist/index.js`; `files` ships `dist`
  (not the source); `prepack` runs the build, so both `npm pack` and
  `npm publish` produce the compiled artifact.
- In-repo, nothing changes: tests still execute `bin/index.ts` directly via type
  stripping. The build is a **publish-time** concern only.
- `TEMPLATES_DIR` resolves as `../../templates` from the bin; `dist/` and `bin/`
  sit at the same depth under the package, so the path is unchanged.
- A test (`test/installed-bin.test.ts`) packs, extracts into a real
  `node_modules/@lntt/create`, and runs the published `bin` entry from there —
  reproducing the install-time path so this class of breakage fails in CI.

## Consequences

- \+ The published CLI actually runs where users install it.
- \+ TypeScript authoring and the fast, build-free in-repo dev loop are kept.
- − "No build step" now has an exception: publishing compiles. The claim is only
  true for in-repo execution — see the note in
  [ADR-0003](./0003-create-vite-monorepo-model.md) and CLAUDE.md.
- − One more moving part on release (`prepack`); a stale `dist/` can't leak,
  since it is git-ignored and rebuilt on every pack.
