---
status: accepted
date: 2026-07-13
tags: [typescript, esm, imports, cli, templates]
---

# ADR-0007: Explicit `.ts` import extensions for Node-executed code

## Context

`@lntt/create` runs as TypeScript with no build step in this repo — Node ≥24
executes `bin/index.ts` via native type stripping — and ships compiled to `dist/`
on publish ([ADR-0005](./0005-publish-compiled-cli.md)). Type stripping is stable
and default from Node 24.12.0, and TypeScript 7.0 is GA; the ecosystem has
converged on running `.ts` directly.

Native ESM makes one rule non-negotiable: **the file extension in an `import`
specifier is imposed by Node's resolver, not by TypeScript.** Extensionless ESM
resolution does not exist, and no TS compiler option makes the extension
optional. The official Node docs are explicit — `import './file.ts'`, not
`import './file'`. TypeScript's own guidance for Node users is `module: nodenext`
plus `verbatimModuleSyntax`, `erasableSyntaxOnly`, and
`rewriteRelativeImportExtensions`; TS 6.0+ assumes `allowImportingTsExtensions`.

So the future-proof direction is **not** to drop the extension — it is to write
the true `.ts` extension explicitly. `bin/index.ts` is a single file with **zero
relative imports** today (it imports only `node:` builtins), so this is a forward
guardrail for when the CLI grows a second module, not a migration.

The same question reaches the templates, but they run under a different resolver.
A template is a self-contained project ([ADR-0002](./0002-what-is-a-lunette-template.md),
[ADR-0003](./0003-create-vite-monorepo-model.md)) whose UI runs behind a bundler,
where extensionless resolution is legitimate — yet the template still opts for the
explicit extension, for one uniform style. This ADR governs the **system** side and
the cross-level stance; the template's own convention lives in its own ADR-0003.

## Decision

Across Lunette TypeScript that **Node executes directly**, write relative imports
with the explicit source extension — `./x.ts`, `./x.tsx` — never extensionless and
never the `.js`-pointing-at-`.ts` workaround.

For the CLI, `packages/create/tsconfig.json` already carries `module`/
`moduleResolution: nodenext`, `verbatimModuleSyntax`, and `erasableSyntaxOnly`.
Adopt, when the first relative import lands, the two options that realise the
convention for a package that also **emits** (ADR-0005):

- `allowImportingTsExtensions` — permit the `.ts` specifier in source.
- `rewriteRelativeImportExtensions` — rewrite `./x.ts` → `./x.js` on emit to
  `dist/`, so the compiled artifact resolves under `node_modules`.

Both are needed together: `allowImportingTsExtensions` alone requires `noEmit`;
paired with `rewriteRelativeImportExtensions` it is allowed alongside the build.

**Cross-level scope.** This ADR governs the CLI directly. Templates are
self-contained and decide their own conventions, but adopt the same explicit-
extension convention independently — recorded in their own ADR-0003 (the
react-router template applies it across both its Node-first domain layer and its
bundler-bound UI). What differs across levels is the **runtime, not the writing
convention**: code behind a bundler keeps `moduleResolution: bundler`, Node-run
code uses `nodenext`. The two deliberately **diverge on runtime** while
**converging on writing convention and strictness**. There is no shared tsconfig
base between them to reconcile; the divergence is intentional, not drift.

## Alternatives considered

### Extensionless imports

The prevailing bundler-era idiom. Rejected for Node-executed code: it is not
resolvable by Node's ESM resolver at all, so it only works behind a bundler. It
bets on the trajectory TypeScript and Node are deprecating.

### The `.js` extension pointing at `.ts` source

Write `import './x.js'` while the file on disk is `x.ts` — long the standard
`nodenext` workaround. Rejected: it misleads every human and tool that reads the
specifier, and it is now obsolete — TS and Node support writing the real `.ts`,
with `rewriteRelativeImportExtensions` handling emit.

## Consequences

### Positive

- Import specifiers tell the truth: the extension names the file that exists.
- Aligned with the current Node + TypeScript direction, not the bundler holdover.
- When a file moves between runtimes, one migration axis (extensions) is already
  settled.

### Negative / accepted risks

- The convention is inert until the CLI has a relative import; it is a guardrail,
  not a change with visible effect today.
- Two module-resolution modes coexist across the repo (nodenext for Node-run code,
  bundler for template UI). Deliberate — see the cross-level scope above.

### When to deviate (revisit triggers)

- Node or TypeScript restores a form of extensionless ESM resolution (they will
  not, but if the resolver contract changes, revisit).
- A future package here runs *only* behind a bundler; it follows the bundler
  idiom, not this ADR.
