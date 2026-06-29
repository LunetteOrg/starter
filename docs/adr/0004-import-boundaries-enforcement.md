# ADR-0004: Import boundaries enforced by Biome and architecture tests

- Status: accepted
- Date: 2026-03-17

## Context

The layer boundaries of ADR-0003 are worthless if they only live in documentation. They must fail fast (pre-commit) and fail reliably (CI), without adding a new tool to the stack.

## Decision

Two independent nets, both expressing the same matrix:

**1. Biome, at lint time (pre-commit + CI).** Root `biome.json` carries `overrides` keyed on layer globs that work for any app under `apps/*`:

- `apps/*/app/domain/**` — `noRestrictedImports` bans `react-router` and `#app/lib`.
- `apps/*/app/use-cases/**` — bans `react-router` and `#app/lib/db`; concrete infrastructure modules (e.g. `#app/lib/email`) are added to this override as they appear.
- `apps/*/app/routes/**` — bans `#app/use-cases`, `#app/domain`, `#app/lib/db`, `#app/bootstrap`.
- `apps/*/app/**` (excluding tests) — `noRestrictedGlobals` bans `Date` in favour of `Temporal`.
- `apps/*/__tests__/**/*.e2e.ts` — GritQL plugins from `packages/biome-config/` ban `waitForTimeout()` (implicit sync) and React internals (`__reactProps$`/`__reactFiber$`) in e2e tests.

**2. Architecture tests, at CI time.** Each app ships an `app/arch.spec.ts` built on `@starter/test-utils`, asserting the same matrix by scanning sources. Use `assertLayerBoundaries` (auto-discovers a layer's files, merges the default `*.spec.ts`/`*.test.ts` excludes, and is built on `getImports` so it also catches dynamic `import()`); drop to the lower-level `getImports` + `assertNoForbiddenImports` only for bespoke checks. Canonical template:

```ts
import { resolve } from 'node:path'
import { assertLayerBoundaries } from '@starter/test-utils'
import { describe, it } from 'vitest'

const APP = resolve(__dirname)

describe('architecture boundaries', () => {
  it('domain imports no framework or lib', async () => {
    await assertLayerBoundaries({
      pattern: resolve(APP, 'domain/**/*.{ts,tsx}'),
      layer: 'domain',
      forbidden: [/^react-router/, /^#app\/lib\//],
    })
  })
  it('routes reach the app only through context', async () => {
    await assertLayerBoundaries({
      pattern: resolve(APP, 'routes/**/*.{ts,tsx}'),
      layer: 'routes',
      forbidden: [/^#app\/use-cases/, /^#app\/domain/, /^#app\/lib\/db/, /^#app\/bootstrap/],
    })
  })
  it('use-cases import no framework or db', async () => {
    await assertLayerBoundaries({
      pattern: resolve(APP, 'use-cases/**/*.{ts,tsx}'),
      layer: 'use-cases',
      forbidden: [/^react-router/, /^#app\/lib\/db/],
    })
  })
})
```

A ready-to-copy version lives at `packages/test-utils/templates/layer.arch.spec.ts.template`.

Path aliases use Node.js subpath imports (`"imports": { "#app/*": … }` in each app's `package.json`) — portable, no bundler-specific config, and a stable target for both nets.

## Consequences

- \+ Violations surface in the editor and at pre-commit (Biome), and cannot slip past CI even if a hook is skipped (arch tests).
- \+ New apps inherit the Biome rules for free via the `apps/*` globs; they only need to add `arch.spec.ts`.
- − The matrix is written twice (Biome config + test). Accepted: the redundancy is the feature.
- − The use-cases override must be extended manually when a new infrastructure module lands in `lib/`.
