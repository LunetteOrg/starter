import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getImports } from './arch'

const FIXTURES = resolve(__dirname, '__fixtures__/layer')

describe('getImports', () => {
  describe('test file exclusion', () => {
    it('excludes .spec.ts and .test.ts files by default', async () => {
      const imports = await getImports(`${FIXTURES}/**/*.ts`)
      const files = [...imports.keys()]
      expect(files.some((f) => f.endsWith('source.ts'))).toBe(true)
      expect(files.some((f) => f.endsWith('.spec.ts'))).toBe(false)
      expect(files.some((f) => f.endsWith('.test.ts'))).toBe(false)
    })

    it('includes test files when ignore is overridden to empty', async () => {
      const imports = await getImports(`${FIXTURES}/**/*.ts`, { ignore: [] })
      const files = [...imports.keys()]
      expect(files.some((f) => f.endsWith('.spec.ts'))).toBe(true)
      expect(files.some((f) => f.endsWith('.test.ts'))).toBe(true)
    })
  })

  describe('dynamic import detection', () => {
    it('captures import() expressions', async () => {
      const imports = await getImports(`${FIXTURES}/lazy.ts`)
      const lazyImports = imports.get(resolve(FIXTURES, 'lazy.ts'))
      expect(lazyImports).toContain('~/domain/lazy-route')
    })

    it('merges static and dynamic imports for the same file', async () => {
      const imports = await getImports(`${FIXTURES}/mixed.ts`)
      const mixedImports = imports.get(resolve(FIXTURES, 'mixed.ts'))
      expect(mixedImports).toContain('~/domain/static-dep')
      expect(mixedImports).toContain('~/domain/lazy-dep')
    })

    it('captures the static prefix of template-literal dynamic imports', async () => {
      const imports = await getImports(`${FIXTURES}/template-lazy.ts`)
      const fileImports = imports.get(resolve(FIXTURES, 'template-lazy.ts'))
      // import(`~/domain/${routeName}`) — static prefix '~/domain/' must be captured
      expect(fileImports?.some((i) => i.startsWith('~/domain/'))).toBe(true)
    })

    it('captures multiline dynamic imports', async () => {
      const imports = await getImports(`${FIXTURES}/multiline-lazy.ts`)
      const fileImports = imports.get(resolve(FIXTURES, 'multiline-lazy.ts'))
      expect(fileImports).toContain('~/domain/multiline-route')
    })
  })

  describe('error handling', () => {
    it('throws when no files match', async () => {
      await expect(getImports(`${FIXTURES}/nonexistent/**/*.ts`)).rejects.toThrow(
        /No files matched/,
      )
    })
  })
})
