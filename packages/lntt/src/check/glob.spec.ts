import { assert, describe, it } from '@effect/vitest'
import { matchesGlob } from './glob.ts'

describe('a glob of the configuration', () => {
  it("matches as node:path's matchesGlob: a wildcard skips a name that starts with a dot", () => {
    for (const [path, glob, matches] of [
      ['src/a.test.ts', '**/*.test.*', true],
      ['a.test.ts', '**/*.test.*', true],
      ['packages/a/src/x.spec.ts', 'packages/*/src/**/*.spec.ts', true],
      ['src/x.ts', 'src/{a,x}.ts', true],
      ['test/x/y.test.ts', 'test/*.test.ts', false],
      ['.github/workflows/x.yml', '**/*.yml', false],
      ['a/.x.test.ts', '**/*.test.*', false],
      ['.agents/x', '.agents/*', true],
    ] as const) {
      assert.strictEqual(matchesGlob(path, glob), matches, `${path} ${glob}`)
    }
  })
})
