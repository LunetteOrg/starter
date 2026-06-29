import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertLayerBoundaries, getImports } from './arch'

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

  // Regression guard (ADR-0004): boundaries must not be launderable through
  // re-exports or type-only imports. These forms all carry `from '...'`, so the
  // current `from`-based scan catches them. If any of these ever fail, that is
  // the signal to replace the regex scan with a TS-AST walk — not to relax the
  // assertion.
  describe('re-export and type-only import detection', () => {
    it('captures `export *` and `export { } from` specifiers', async () => {
      const imports = await getImports(`${FIXTURES}/reexport.ts`)
      const fileImports = imports.get(resolve(FIXTURES, 'reexport.ts'))
      expect(fileImports).toContain('~/domain/reexported-all')
      expect(fileImports).toContain('~/domain/reexported-named')
    })

    it('captures `import type ... from` specifiers', async () => {
      const imports = await getImports(`${FIXTURES}/type-import.ts`)
      const fileImports = imports.get(resolve(FIXTURES, 'type-import.ts'))
      expect(fileImports).toContain('~/domain/type-only')
    })

    it('fails a boundary check on a forbidden re-export', async () => {
      await expect(
        assertLayerBoundaries({
          pattern: `${FIXTURES}/reexport.ts`,
          layer: 'domain',
          forbidden: [/~\/domain\//],
        }),
      ).rejects.toThrow(/domain violation/)
    })

    it('fails a boundary check on a forbidden type-only import', async () => {
      await expect(
        assertLayerBoundaries({
          pattern: `${FIXTURES}/type-import.ts`,
          layer: 'domain',
          forbidden: [/~\/domain\//],
        }),
      ).rejects.toThrow(/domain violation/)
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

describe('assertLayerBoundaries', () => {
  it('passes when no file imports a forbidden specifier', async () => {
    await expect(
      assertLayerBoundaries({
        pattern: `${FIXTURES}/**/*.ts`,
        layer: 'domain',
        forbidden: [/^react-router/],
      }),
    ).resolves.toBeUndefined()
  })

  it('fails on a forbidden static import', async () => {
    await expect(
      assertLayerBoundaries({
        pattern: `${FIXTURES}/source.ts`,
        layer: 'domain',
        forbidden: [/~\/domain\//],
      }),
    ).rejects.toThrow(/domain violation/)
  })

  it('fails on a forbidden dynamic import() that inline regex guards would miss', async () => {
    await expect(
      assertLayerBoundaries({
        pattern: `${FIXTURES}/lazy.ts`,
        layer: 'domain',
        forbidden: [/~\/domain\//],
      }),
    ).rejects.toThrow(/domain violation/)
  })

  it('throws (no vacuous pass) when the pattern matches no files', async () => {
    await expect(
      assertLayerBoundaries({
        pattern: `${FIXTURES}/nonexistent/**/*.ts`,
        layer: 'domain',
        forbidden: [/whatever/],
      }),
    ).rejects.toThrow(/No files matched/)
  })
})
