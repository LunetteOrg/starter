# Imports & module resolution

- Status: guidance

> **Recommended, not enforced (yet).** The *decision* — why explicit `.ts`
> everywhere — lives in [ADR-0003 → Module resolution & import convention](../adr/0003-build-and-tooling.md#module-resolution--import-convention).
> This page is the operational how-to. It is not linted today; if a rule is added
> it must carve out generated code (see below).

## The rule in one line

Relative imports carry the **explicit source extension**:

```ts
import { Button } from './button.tsx'   // ✓  a component
import { toCents } from './money.ts'     // ✓  a module
import { Button } from './button'        // ✗  extensionless — not resolvable by Node ESM
import { toCents } from './money.js'     // ✗  the .js-pointing-at-.ts workaround, now obsolete
```

Bare specifiers are unchanged — no extension on packages or `node:` builtins
(`import { z } from 'zod'`, `import { readFile } from 'node:fs/promises'`).

## Type-only imports must say so

Native type stripping removes types by erasure, so a type imported as a value
becomes a runtime error. Mark them — `verbatimModuleSyntax` enforces it:

```ts
import type { Money } from './money.ts'
import { toCents, type Currency } from './money.ts'
```

## Which resolution mode where

The extension is uniform; the resolver is not, and it follows the runtime.

| Layer | `moduleResolution` | Runs under |
|---|---|---|
| UI / app packages | `bundler` | Vite/Rolldown (JSX, CSS, assets) |
| Domain & non-UI libraries | `nodenext` | Node directly (native type stripping) |

Keep the **domain Node-first**: no bundler-only imports — no JSX, no
`.css`/asset/`?raw`/`virtual:` — so `node` can run it without a build. That
absence, not the extension, is what makes it portable. A domain package that
emits also sets `rewriteRelativeImportExtensions` so `./x.ts` compiles to `./x.js`.

## The one exception: generated code

React Router's typegen emits **extensionless** imports — it ignores
`moduleResolution` — and build tools write their own output. Don't rewrite
generated files, and don't fight the generators. A lint rule that enforces this
convention must exclude generated and build directories (`.react-router/`,
Storybook build output).
