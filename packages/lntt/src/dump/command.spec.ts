import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as TestConsole from 'effect/testing/TestConsole'
import { PackageDir } from '../sync/project.ts'
import { filesAt } from '../testing/fixtures.ts'
import { memorySpawner } from '../testing/spawner.ts'
import { command, type DumpCommand, queryOf } from './command.ts'

const ROOT = '/r'
const MACHINE = { node: 'v24.1.0', os: 'Darwin 27.0.0 arm64', home: '/home/u' }

// One run of `lntt dump` from `cwd` on a project of `files`, lntt's package at /lntt (none with
// `lntt: false`), git with no remote and the failing command answered by `failing`.
const lntt = (
  parsed: Partial<DumpCommand>,
  files: Record<string, string> = { '.agents/config.jsonc': '{}', 'package.json': '{"name":"app"}' },
  options: { lntt?: boolean } = {},
) => {
  const fs = filesAt(ROOT, files)
  if (options.lntt !== false)
    fs.files.set('/lntt/package.json', { text: '{"name":"@lntt/lntt","version":"0.6.5"}', mtime: 0 })
  Effect.runSync(fs.dir('/lntt/dist'))
  const spawner = memorySpawner((command) => (command === 'git' ? { out: '' } : { out: 'oops\n', code: 3 }))
  return Effect.gen(function* () {
    const ended = yield* command({ cwd: ROOT, env: {}, machine: MACHINE, json: false, ...parsed })
    const out = (yield* TestConsole.logLines).join('\n')
    const err = (yield* TestConsole.errorLines).join('\n')
    return { ...ended, out, err }
  }).pipe(
    Effect.provide(Layer.mergeAll(fs.layer, Path.layer, spawner.layer, Layer.fresh(TestConsole.layer))),
    Effect.provideService(PackageDir, '/lntt/dist'),
  )
}

describe('lntt dump', () => {
  it.effect('prints the dump as Markdown, the failing command run after --; exit 0', () =>
    Effect.gen(function* () {
      const run = yield* lntt({ failing: ['pnpm', 'test'], model: 'm1' })
      assert.strictEqual(run.code, 0, run.err)
      assert.match(run.out, /^### lntt\n\n- version: 0\.6\.5\n/)
      assert.match(run.out, /- model: m1/)
      assert.match(run.out, /- command: pnpm test\n- exit: 3\n/)
      assert.isFalse(run.out.endsWith('\n'))
    }),
  )

  it.effect('--json prints the same dump as one object; from a subfolder the root is the project’s', () =>
    Effect.gen(function* () {
      const run = yield* lntt(
        { json: true, cwd: `${ROOT}/src` },
        {
          '.agents/config.jsonc': '{}',
          'src/app.ts': '',
        },
      )
      const dump = JSON.parse(run.out)
      assert.match(
        dump.sections.find((s: { title: string }) => s.title === 'Project').lines.join('\n'),
        /configuration: \.agents\/config\.jsonc/,
      )
    }),
  )

  it.effect('a configuration that does not validate: the whole dump printed, then exit 1 with its error', () =>
    Effect.gen(function* () {
      const run = yield* lntt({}, { '.agents/config.jsonc': '{ "nope": 1 }' })
      assert.strictEqual(run.code, 1)
      assert.match(run.out, /### Project\n/)
      assert.match(run.err, /^lntt dump: \/r\/\.agents\/config\.jsonc does not match the schema/)
    }),
  )

  it.effect(
    'with a query nothing is printed: the dump waits for the query, its code 1 when the configuration is red',
    () =>
      Effect.gen(function* () {
        const parsed = { query: '.lntt', json: false }
        const green = yield* lntt(parsed)
        assert.deepStrictEqual([green.code, green.out, green.err], [null, '', ''])
        assert.strictEqual(queryOf({ cwd: ROOT, env: {}, machine: MACHINE, ...parsed }, green.dump as never).code, 0)
        const red = yield* lntt(parsed, { '.agents/config.jsonc': '{ "nope": 1 }' })
        assert.strictEqual(red.code, null)
        const query = queryOf({ cwd: ROOT, env: {}, machine: MACHINE, ...parsed }, red.dump as never)
        assert.deepStrictEqual([query.code, query.command, JSON.parse(query.input).lntt], [1, 'lntt dump', '0.6.5'])
      }),
  )

  it.effect('lntt’s own package not found above its code is one line, exit 1', () =>
    Effect.gen(function* () {
      const run = yield* lntt({}, undefined, { lntt: false })
      assert.deepStrictEqual(
        [run.code, run.out, run.err],
        [1, '', 'lntt dump: the package.json of @lntt/lntt is not above its code'],
      )
    }),
  )
})
