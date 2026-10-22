import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertLintFailsOnWarnings } from './lint.ts'
import { assertNoModuleMocks } from './module-mocks.ts'
import { assertWaitingWorkspacesRunTheGuard } from './waits.ts'

/**
 * The generic guards, run on this repo. The templates under packages/create, and the
 * repositories lntt's tests run against, are projects of their own: not scanned here.
 */
const REPO = resolve(__dirname, '../../..')
const NOT_THIS_REPO = ['packages/create/templates/**', 'packages/lntt/test/fixtures/**']

describe('this repo', () => {
  it('mocks no module for the whole worker', () => {
    expect(() => assertNoModuleMocks(REPO, { ignore: NOT_THIS_REPO })).not.toThrow()
  })

  it('runs the wait guard in every workspace whose tests wait', () => {
    expect(() => assertWaitingWorkspacesRunTheGuard(REPO, { ignore: NOT_THIS_REPO })).not.toThrow()
  })

  it('fails its lint scripts on a warning', () => {
    expect(() => assertLintFailsOnWarnings(REPO)).not.toThrow()
  })
})
