import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { probeProject } from './probe-kit.ts'

describe('probeProject', () => {
  let left = ''

  it('writes each file of the project', () => {
    left = probeProject({ 'packages/ui/package.json': '{}' })
    expect(readFileSync(join(left, 'packages/ui/package.json'), 'utf8')).toBe('{}')
  })

  it('removes the project once the test that built it finishes', () => {
    expect(left).not.toBe('')
    expect(existsSync(left)).toBe(false)
  })
})
