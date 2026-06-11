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

**2. Architecture tests, at CI time.** Each app ships an `app/arch.spec.ts` built on `@starter/test-utils` (`getImports` + `assertNoForbiddenImports`), asserting the same matrix by scanning sources. Canonical template:

```ts
import { resolve } from 'node:path'
import { assertNoForbiddenImports, getImports } from '@starter/test-utils'
import { describe, it } from 'vitest'

const APP = resolve(__dirname)

describe('architecture boundaries', () => {
  it('domain must not import react-router', async () => {
    assertNoForbiddenImports(await getImports(`${APP}/domain/**/*.ts`), [/react-router/], 'domain')
  })
  it('domain must not import #app/lib', async () => {
    assertNoForbiddenImports(await getImports(`${APP}/domain/**/*.ts`), [/#app\/lib/], 'domain')
  })
  it('routes must not import use-cases/domain/db/bootstrap', async () => {
    const imports = await getImports(`${APP}/routes/**/*.{ts,tsx}`)
    assertNoForbiddenImports(
      imports,
      [/#app\/use-cases/, /#app\/domain/, /#app\/lib\/db/, /#app\/bootstrap/],
      'routes',
    )
  })
  it('use-cases must not import framework or db', async () => {
    const imports = await getImports(`${APP}/use-cases/**/*.ts`)
    assertNoForbiddenImports(imports, [/react-router/, /#app\/lib\/db/], 'use-cases')
  })
})
```

Path aliases use Node.js subpath imports (`"imports": { "#app/*": … }` in each app's `package.json`) — portable, no bundler-specific config, and a stable target for both nets.

## Consequences

- \+ Violations surface in the editor and at pre-commit (Biome), and cannot slip past CI even if a hook is skipped (arch tests).
- \+ New apps inherit the Biome rules for free via the `apps/*` globs; they only need to add `arch.spec.ts`.
- − The matrix is written twice (Biome config + test). Accepted: the redundancy is the feature.
- − The use-cases override must be extended manually when a new infrastructure module lands in `lib/`.
