import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { glob } from 'glob'
import { describe, expect, it } from 'vitest'

/**
 * Self-arming architecture enforcement (ADR-0002: import boundaries and self-arming enforcement).
 *
 * Import boundaries are guarded by TWO nets: Biome `noRestrictedImports`
 * overrides (auto-applied by glob to `apps/*`) and a per-app
 * `app/arch.spec.ts` (which catches dynamic `import()` the linter misses).
 * The asymmetry: the Biome net arrives for free, but the arch test must be
 * copied into each new app by hand — easy to forget, and the boundaries drift
 * before anyone notices.
 *
 * This meta-test closes that gap WITHOUT adding friction to the template: it is
 * data-driven on discovery, so at day-0 (`apps/` holding only `.gitkeep`) it
 * iterates over nothing and passes. The first time someone scaffolds
 * `apps/<x>/app/`, the rule arms itself and fails until the arch test is
 * present — pointing at `packages/test-utils/templates/layer.arch.spec.ts.template`.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))
// packages/test-utils/src → repo root
const REPO_ROOT = resolve(__dirname, '../../..')
const APPS_DIR = resolve(REPO_ROOT, 'apps')

async function appsWithLayer(): Promise<string[]> {
  const appDirs = await glob('*/', { cwd: APPS_DIR, absolute: true })
  return appDirs.map((dir) => resolve(dir)).filter((dir) => existsSync(resolve(dir, 'app')))
}

describe('per-app architecture enforcement', () => {
  it('every app with an app/ layer ships an app/arch.spec.ts', async () => {
    const offenders = (await appsWithLayer())
      .filter((dir) => !existsSync(resolve(dir, 'app/arch.spec.ts')))
      .map((dir) => resolve(dir, 'app/arch.spec.ts'))

    expect(
      offenders,
      `Missing per-app architecture test(s). Copy ` +
        `packages/test-utils/templates/layer.arch.spec.ts.template into:\n` +
        offenders.map((f) => `  - ${f}`).join('\n'),
    ).toEqual([])
  })

  // Presence alone is gameable: an empty or commented-out arch.spec.ts would
  // pass the check above while enforcing nothing. Require an actual CALL to the
  // boundary assertion (`assertLayerBoundaries(`), not a mere mention — so the
  // net cannot be defeated by a file that only names it in a comment (ADR-0002 — self-arming enforcement).
  it('each app/arch.spec.ts actually invokes assertLayerBoundaries', async () => {
    const offenders = (await appsWithLayer())
      .map((dir) => resolve(dir, 'app/arch.spec.ts'))
      .filter((file) => existsSync(file))
      .filter((file) => !/assertLayerBoundaries\s*\(/.test(readFileSync(file, 'utf-8')))

    expect(
      offenders,
      `These arch.spec.ts files don't call assertLayerBoundaries (they enforce ` +
        `nothing):\n${offenders.map((f) => `  - ${f}`).join('\n')}`,
    ).toEqual([])
  })
})
