import { describe, expect, it } from 'vitest'
import { assertNoModuleMocks, findModuleMocks } from './module-mocks.ts'
import { probeProject } from './probe-kit.ts'

const pkg = '{ "name": "x" }'

const SCOPED = [
  "it('reads the flag', async () => {",
  '  vi.resetModules()',
  "  vi.doMock('./flags.ts', () => ({ on: true }))",
  "  const { on } = await import('./flags.ts')",
  '  expect(on).toBe(true)',
  "  vi.doUnmock('./flags.ts')",
  '  vi.resetModules()',
  '})',
].join('\n')

describe('findModuleMocks', () => {
  it('reports a hoisted vi.mock on its line', () => {
    expect(findModuleMocks("import { a } from './a.ts'\n\nvi.mock('./db.ts', () => ({}))\n")).toEqual([
      { line: 3, message: expect.stringMatching(/hoisted vi\.mock/) },
    ])
  })

  it('ignores vi.mock in a comment or a string', () => {
    expect(findModuleMocks("// vi.mock('./db.ts')\nconst doc = \"vi.mock('./db.ts')\"\n")).toEqual([])
  })

  it('sees a vi.mock after a regex literal holding a quote', () => {
    expect(findModuleMocks("it('x', () => expect(m).toMatch(/can't/))\nvi.mock('./db.ts')\n")).toHaveLength(1)
    expect(findModuleMocks("const QUOTE = /[\"']/\nvi.mock('./db.ts')\n")).toHaveLength(1)
  })

  it('lets a vi.doMock with the registry reset around it through', () => {
    expect(findModuleMocks(SCOPED)).toEqual([])
  })

  it.each([
    [
      'no reset before the first doMock',
      SCOPED.replace('  vi.resetModules()\n  vi.doMock', '  vi.doMock'),
      /before/,
      2,
    ],
    ['no doUnmock', SCOPED.replace("  vi.doUnmock('./flags.ts')\n", ''), /vi\.doUnmock/, 3],
    [
      'no reset after the last doUnmock',
      SCOPED.replace("doUnmock('./flags.ts')\n  vi.resetModules()", "doUnmock('./flags.ts')"),
      /after/,
      3,
    ],
  ])('catches a vi.doMock with %s, on the line of the first doMock', (_, source, reason, line) => {
    const found = findModuleMocks(source)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ line, message: expect.stringMatching(reason) })
  })

  it('wants the reset before the first of several doMocks, not before any of them', () => {
    const twoTests = [
      "it('reads a', async () => {",
      "  vi.doMock('./a.ts', () => ({}))",
      "  vi.doUnmock('./a.ts')",
      '  vi.resetModules()',
      '})',
      "it('reads b', async () => {",
      '  vi.resetModules()',
      "  vi.doMock('./b.ts', () => ({}))",
      "  vi.doUnmock('./b.ts')",
      '  vi.resetModules()',
      '})',
    ].join('\n')
    expect(findModuleMocks(twoTests)).toEqual([{ line: 2, message: expect.stringMatching(/before/) }])
  })
})

describe('assertNoModuleMocks', () => {
  it('fails naming each file and line, in specs, kits and test/ helpers', () => {
    const root = probeProject({
      'apps/web/package.json': pkg,
      'apps/web/app/page.spec.tsx': "vi.mock('./db.ts')\n",
      'apps/web/app/editor-kit.ts': "\nvi.mock('./db.ts', () => ({}))\n",
      'packages/db/package.json': pkg,
      'packages/db/test/render.ts': "export {}\n\n\nvi.mock('../src/db.ts')\n",
      'packages/db/src/repo.test.ts': SCOPED,
      // Not test modules: production code, Playwright, a probe kept as a fixture.
      'packages/db/src/repo.ts': "vi.mock('./db.ts')\n",
      'packages/db/e2e/login.spec.ts': "vi.mock('./db.ts')\n",
      'packages/db/src/__fixtures__/x.spec.ts': "vi.mock('./db.ts')\n",
    })
    expect(() => assertNoModuleMocks(root)).toThrow(
      /apps\/web\/app\/editor-kit\.ts:2[\s\S]*apps\/web\/app\/page\.spec\.tsx:1[\s\S]*packages\/db\/test\/render\.ts:4[\s\S]*docs\/adr\/test-guards\.md/,
    )
    let message = ''
    try {
      assertNoModuleMocks(root)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).not.toMatch(/repo\.ts|e2e|__fixtures__|repo\.test\.ts/)
  })

  it('passes a project whose tests mock only inside a test, with the registry reset', () => {
    const root = probeProject({
      'packages/db/package.json': pkg,
      'packages/db/src/repo.test.ts': SCOPED,
      'packages/db/src/notes.spec.ts': "// never vi.mock('./db.ts') here\nit('x', () => {})\n",
    })
    expect(() => assertNoModuleMocks(root)).not.toThrow()
  })

  it('skips the paths it is told to ignore', () => {
    const root = probeProject({
      'packages/db/package.json': pkg,
      'packages/db/src/ok.spec.ts': "it('x', () => {})\n",
      'packages/db/vendor/x.spec.ts': "vi.mock('./db.ts')\n",
    })
    expect(() => assertNoModuleMocks(root, { ignore: ['packages/db/vendor/**'] })).not.toThrow()
  })

  it('fails when it finds no test file, rather than pass on nothing', () => {
    const root = probeProject({ 'packages/db/package.json': pkg, 'packages/db/src/index.ts': '' })
    expect(() => assertNoModuleMocks(root)).toThrow(/no test file/)
  })
})
