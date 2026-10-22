import { describe, expect, it } from 'vitest'
import { WORKSPACE_LABEL, workspaceRoot } from './index.ts'

/** Unit test: loading the root entry starts nothing, so it needs no Docker. */
describe('the root entry', () => {
  it('exports the workspace label and workspaceRoot', () => {
    expect(WORKSPACE_LABEL).toBe('com.lntt.workspace')
    expect(workspaceRoot).toBeTypeOf('function')
  })
})
