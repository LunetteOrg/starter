import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Path from 'effect/Path'
import {
  candidates,
  commandFor,
  ImportGraph,
  importsOf,
  isTestFile,
  levelsOf,
  shellQuote,
  testFiles,
  testsConfig,
} from './test-files.ts'
import { memoryTree } from './tree.ts'

const paths = Effect.runSync(Effect.provide(Path.Path, Path.layer))

const CONFIG = testsConfig({
  tests: {
    ignore: ['test/fixtures/**'],
    levels: [
      { name: 'unit', files: ['src/**/*.spec.ts'], run: 'vitest run {files}' },
      { name: 'cli', files: ['test/*.test.ts'], run: 'node --test {files}', cwd: 'test', timeoutSeconds: 30 },
    ],
  },
})

describe('the tests as tests.levels describes them', () => {
  it('the defaults of a level, and no section is no levels', () => {
    assert.deepStrictEqual(testsConfig({}), { levels: [], rules: [], ignore: [], assertions: [] })
    const [unit] = CONFIG.levels
    assert.deepStrictEqual(unit, {
      name: 'unit',
      files: ['src/**/*.spec.ts'],
      exclude: [],
      environment: null,
      harness: [],
      run: 'vitest run {files}',
      coverage: null,
      cwd: '.',
      repeat: 1,
      timeoutSeconds: 120,
    })
  })

  it('a test file is named like one or sits at a level, less what is ignored and what is no code', () => {
    assert.ok(isTestFile(CONFIG, 'src/a.spec.ts'))
    assert.ok(isTestFile(CONFIG, 'other/b.test.js'))
    assert.ok(!isTestFile(CONFIG, 'test/fixtures/x.test.ts'))
    assert.deepStrictEqual(testFiles(CONFIG, ['a.test.md', 'src/a.spec.ts', 'src/a.ts']), ['src/a.spec.ts'])
    assert.deepStrictEqual(
      levelsOf(CONFIG, 'test/x.test.ts').map((l) => l.name),
      ['cli'],
    )
  })

  it("a level's command for files, made relative to its folder and quoted", () => {
    const cli = CONFIG.levels[1] as (typeof CONFIG.levels)[number]
    assert.strictEqual(
      commandFor(paths, 'node --test {files} > {out}', cli, ["test/it's.test.ts"], '/tmp/o'),
      `node --test 'it'\\''s.test.ts' > '/tmp/o'`,
    )
    assert.strictEqual(shellQuote('a b'), "'a b'")
  })
})

describe('which tests can run a file', () => {
  const tree = memoryTree('/repo', {
    'src/a.ts': "import { b } from './b'\nexport const a = b\n",
    'src/b.ts': 'export const b = 1\n',
    'src/c.ts': 'export const c = 1\n',
    'src/lib/index.ts': "export * from '../c.js'\n",
    'src/a.spec.ts': "import { a } from './a.ts'\n",
    'src/lib.spec.ts': "import './lib'\n",
    'test/cli.test.ts': "const BIN = resolve(HERE, '../src/a.ts')\n",
  })

  it('a file names the files of the project it imports, as TypeScript or a bundler writes the specifier', () => {
    const known = new Set(tree.files)
    assert.deepStrictEqual(importsOf(paths, tree, 'src/a.ts', known), ['src/b.ts'])
    assert.deepStrictEqual(importsOf(paths, tree, 'src/lib/index.ts', known), ['src/c.ts'])
    assert.deepStrictEqual(importsOf(paths, tree, 'src/lib.spec.ts', known), ['src/lib/index.ts'])
    assert.deepStrictEqual(importsOf(paths, tree, 'test/cli.test.ts', known), ['src/a.ts'])
    assert.deepStrictEqual(importsOf(paths, tree, 'gone.ts', known), [])
  })

  it('the tests whose imports reach a file, by level; a test file is its own candidate', () => {
    const graph = new ImportGraph(paths, tree)
    const of = (file: string) =>
      candidates(CONFIG, tree, file, graph).map((c) => `${c.level.name}: ${c.files.join(', ')}`)
    assert.deepStrictEqual(of('src/b.ts'), ['unit: src/a.spec.ts', 'cli: test/cli.test.ts'])
    assert.deepStrictEqual(of('src/c.ts'), ['unit: src/lib.spec.ts'])
    assert.deepStrictEqual(of('src/a.spec.ts'), ['unit: src/a.spec.ts'])
  })
})
