import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertNoSourcePattern, blankComments, blankCommentsAndStrings, findSourceMatches } from './source-scan.ts'

const FIXTURES = resolve(__dirname, '__fixtures__/source-scan')

const NO_THROW = { regex: /\bthrow\s+new\s+\w*Error\b/, message: 'Use errore typed errors.' }
const NO_PROCESS_ENV = {
  regex: /\bprocess\s*\.\s*env\b/,
  message: 'Read env only in config/env.ts.',
}

describe('blankCommentsAndStrings', () => {
  it('blanks comment and string contents but preserves positions and newlines', () => {
    const src = "a // process.env\n'throw new Error'\nb"
    const out = blankCommentsAndStrings(src)
    expect(out.split('\n')).toHaveLength(3) // line count preserved
    expect(out).not.toMatch(/process\.env/)
    expect(out).not.toMatch(/throw new Error/)
    expect(out.startsWith('a ')).toBe(true) // real code kept
    expect(out.trimEnd().endsWith('b')).toBe(true)
  })

  it.each([
    "expect(m).toMatch(/can't/)\nprocess.env.X",
    'const QUOTE = /["\']/\nprocess.env.X',
    "const r = /[/']/g; process.env.X",
    'if (!/`/.test(s)) process.env.X',
    "return /\\/'/\nprocess.env.X",
    "const f = (s) => /'/.test(s)\nprocess.env.X",
    "/'/.test(s)\nprocess.env.X",
    "\n  /'/.test(s)\nprocess.env.X",
  ])('reads a quote inside a regex literal as no string: %s', (src) => {
    expect(blankCommentsAndStrings(src)).toMatch(/process\.env\.X/)
  })

  it('reads the / of a self-closing JSX tag after an attribute as no regex', () => {
    expect(blankCommentsAndStrings("const el = <Foo a={1}/>; process.env.X; const p = './x'")).toMatch(
      /process\.env\.X/,
    )
  })

  it('leaves a / with no closing one on its line as code', () => {
    expect(blankCommentsAndStrings("const r = a ? /\nprocess.env.X; const p = './x'")).toMatch(/process\.env\.X/)
  })

  it('keeps division apart from a regex literal', () => {
    expect(blankCommentsAndStrings("const half = xs[0] / 2; const s = 'process.env'")).not.toMatch(/process\.env/)
    expect(blankCommentsAndStrings("const half = total / 2 / count\nconst s = 'process.env'")).not.toMatch(
      /process\.env/,
    )
    expect(blankCommentsAndStrings("const el = <p>x</p>\nconst s = 'process.env'")).not.toMatch(/process\.env/)
    expect(blankCommentsAndStrings("const x = (a) / b + 'a/b'\nprocess.env.X")).toMatch(
      /^const x = \(a\) \/ b \+ ' {3}'\nprocess\.env\.X$/,
    )
  })
})

describe('blankComments', () => {
  it('blanks comments and keeps string literals, escapes included, at the same length', () => {
    const src = "a // NAME\n/* NAME */ env['NAME'] = 'it\\'s'\nb"
    const out = blankComments(src)
    expect(out).toHaveLength(src.length)
    expect(out.split('\n')[0]).toBe('a        ')
    expect(out.split('\n')[1]).toBe("           env['NAME'] = 'it\\'s'")
  })
})

describe('findSourceMatches', () => {
  it('flags a real throw new Error but not one named in a comment/string', async () => {
    const src = [
      '// throw new Error in a comment — must not match',
      'const s = "throw new Error in a string"',
      'throw new Error("real")',
    ].join('\n')
    const hits = findSourceMatches(src, [NO_THROW])
    expect(hits).toHaveLength(1)
    expect(hits[0]?.line).toBe(3)
  })
})

describe('assertNoSourcePattern', () => {
  it('passes on a file that only mentions the patterns in comments/strings', async () => {
    await expect(
      assertNoSourcePattern({
        pattern: `${FIXTURES}/clean.ts`,
        layer: 'app',
        forbidden: [NO_THROW, NO_PROCESS_ENV],
      }),
    ).resolves.toBeUndefined()
  })

  it('fails on throw new Error', async () => {
    await expect(
      assertNoSourcePattern({
        pattern: `${FIXTURES}/throws-error.ts`,
        layer: 'app',
        forbidden: [NO_THROW],
      }),
    ).rejects.toThrow(/forbidden source pattern/)
  })

  it('fails on process.env', async () => {
    await expect(
      assertNoSourcePattern({
        pattern: `${FIXTURES}/uses-process-env.ts`,
        layer: 'app',
        forbidden: [NO_PROCESS_ENV],
      }),
    ).rejects.toThrow(/forbidden source pattern/)
  })

  it('can exclude the one file allowed to read env', async () => {
    await expect(
      assertNoSourcePattern({
        pattern: `${FIXTURES}/*.ts`,
        layer: 'app',
        forbidden: [NO_PROCESS_ENV],
        ignore: ['**/uses-process-env.ts'],
      }),
    ).resolves.toBeUndefined()
  })

  it('throws (no vacuous pass) when the pattern matches no files', async () => {
    await expect(
      assertNoSourcePattern({
        pattern: `${FIXTURES}/none/**/*.ts`,
        layer: 'app',
        forbidden: [NO_THROW],
      }),
    ).rejects.toThrow(/No files matched/)
  })
})
