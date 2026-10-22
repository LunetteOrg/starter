import { describe, expect, it } from 'vitest'
import {
  assertBiomeDomainsDeclared,
  assertLintFailsOnWarnings,
  assertNoModuleMocks,
  assertTestProjectsAreDependencies,
  assertTestsUseTxFixture,
  BIOME_DOMAIN_OF_DEPENDENCY,
  enabledBiomeDomains,
  findDirectTestDbCalls,
  findModuleMocks,
  parseJsonc,
  testProjectPackages,
  WORKSPACE_LABEL,
  workspaceRoot,
} from './index.ts'

/** Unit test: loading the root entry starts nothing, so it needs no Docker. */
describe('the root entry', () => {
  it('exports the workspace label and workspaceRoot', () => {
    expect(WORKSPACE_LABEL).toBe('com.lntt.workspace')
    expect(workspaceRoot).toBeTypeOf('function')
  })
})

// What a project imports from `@lntt/test-utils`: a guard missing from the root export
// would surface only in a consumer's spec.
const GUARDS = {
  assertNoModuleMocks,
  findModuleMocks,
  assertBiomeDomainsDeclared,
  assertLintFailsOnWarnings,
  enabledBiomeDomains,
  parseJsonc,
  assertTestProjectsAreDependencies,
  testProjectPackages,
  assertTestsUseTxFixture,
  findDirectTestDbCalls,
}

describe('the root export', () => {
  it.each(Object.entries(GUARDS))('exports %s', (_, guard) => {
    expect(guard).toBeTypeOf('function')
  })

  it('exports the dependency to Biome domain table', () => {
    expect(BIOME_DOMAIN_OF_DEPENDENCY).toMatchObject({ vitest: 'test' })
  })
})
