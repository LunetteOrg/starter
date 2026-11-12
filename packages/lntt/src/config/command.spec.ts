import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as TestConsole from 'effect/testing/TestConsole'
import schema from '../../schema/config.schema.json' with { type: 'json' }
import { Git } from '../git/git.ts'
import { memoryFileSystem } from '../testing/file-system.ts'
import { type ConfigCommand, command } from './command.ts'

const ROOT = '/project'
const CONFIG = `${ROOT}/.agents/config.jsonc`
const HOME = '/home/me'

// One run of a configuration command on a project whose configuration is `config`: its exit
// code, stdout and stderr.
const lntt = (parsed: ConfigCommand, config: string | null, files: Record<string, string> = {}) => {
  const fs = memoryFileSystem({ dirs: [ROOT, HOME] })
  return Effect.gen(function* () {
    if (config !== null) yield* fs.put(CONFIG, config)
    for (const [path, text] of Object.entries(files)) yield* fs.put(path, text)
    const code = yield* command(parsed, ROOT, HOME)
    const out = (yield* TestConsole.logLines).join('\n')
    const err = (yield* TestConsole.errorLines).join('\n')
    return { code, out, err }
  }).pipe(Effect.provide(Layer.mergeAll(fs.layer, Path.layer, Git.memory({}), Layer.fresh(TestConsole.layer))))
}

const get = (key: string, config: string) => lntt({ kind: 'get', key }, config)
const validate = (config: string) => lntt({ kind: 'validate' }, config)

describe("the project's phase", () => {
  it.effect('development or production, read with lntt get; any other value does not validate', () =>
    Effect.gen(function* () {
      for (const phase of ['development', 'production']) {
        const run = yield* get('project.phase', `{ "project": { "phase": "${phase}" } }`)
        assert.deepStrictEqual([run.code, JSON.parse(run.out)], [0, phase])
      }
      const section = yield* get('project', `{ "project": { "phase": "development" } }`)
      assert.deepStrictEqual(JSON.parse(section.out), { phase: 'development' }, 'the section reads as it is written')
      const beta = yield* get('project.phase', `{ "project": { "phase": "beta" } }`)
      assert.strictEqual(beta.code, 1)
      assert.match(beta.err, /^lntt: [\s\S]*\/project\/phase/)
    }),
  )

  it.effect(
    'a missing key, or a missing section, is production: no project loses a check unless its team says so',
    () =>
      Effect.gen(function* () {
        for (const config of ['{ "recording": { "logs": {} } }', `{ "project": {} }`]) {
          const run = yield* get('project.phase', config)
          assert.deepStrictEqual([run.code, JSON.parse(run.out)], [0, 'production'], config)
        }
      }),
  )

  it.effect(
    'only project.phase reads its default: another missing key, one with a default in the schema too, exits 1',
    () =>
      Effect.gen(function* () {
        assert.strictEqual(schema.properties.board.properties.provider.default, 'github')
        const run = yield* get('board.provider', `{ "board": {} }`)
        assert.strictEqual(run.code, 1)
        assert.match(run.err, /^lntt: no board\.provider in the configuration$/)
      }),
  )
})

describe('lntt validate', () => {
  it.effect('a warningRounds not below maxRounds validates, with a warning that no round blocks on blockers only', () =>
    Effect.gen(function* () {
      const warned = yield* validate('{ "delivery": { "review": { "maxRounds": 3, "warningRounds": 3 } } }')
      assert.strictEqual(warned.code, 0, warned.err)
      assert.strictEqual(
        warned.err,
        'lntt validate: warning: delivery.review.warningRounds (3) is not below delivery.review.maxRounds (3): no round blocks on blockers only',
      )
      const quiet = yield* validate('{ "delivery": { "review": { "maxRounds": 3, "warningRounds": 2 } } }')
      assert.deepStrictEqual([quiet.code, quiet.err], [0, ''])
    }),
  )

  it.effect('delivery.review.stateDir is a path; anything else does not validate', () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* validate('{ "delivery": { "review": { "stateDir": ".git/review" } } }')).code, 0)
      for (const bad of ['3', '""', 'false']) {
        const run = yield* validate(`{ "delivery": { "review": { "stateDir": ${bad} } } }`)
        assert.strictEqual(run.code, 1, bad)
        assert.match(run.err, /stateDir/, bad)
      }
    }),
  )

  it.effect('a value that names no entry of its list exits 1 with the reason, the file named', () =>
    Effect.gen(function* () {
      const run = yield* validate(
        '{ "board": { "issueTypes": { "parents": ["Feature"], "children": ["Bug"], "standalone": ["Feature"] } } }',
      )
      assert.strictEqual(run.code, 1)
      assert.match(run.err, /^lntt: \/project\/\.agents\/config\.jsonc: a value names no entry of its list:\n {2}\S/)
      assert.match(run.err, /board\.issueTypes\.standalone is "Feature", not one of: Bug/)
    }),
  )
})

describe('the other commands', () => {
  it.effect('path, set and operator with no profile', () =>
    Effect.gen(function* () {
      const recording = '{ "recording": { "logs": {} } }'
      assert.strictEqual((yield* lntt({ kind: 'path' }, '{}')).out, CONFIG)
      assert.deepStrictEqual(yield* lntt({ kind: 'set', key: 'recording.language', value: 'it' }, recording), {
        code: 0,
        out: '',
        err: '',
      })
      const refused = yield* lntt({ kind: 'set', key: 'recording.language', value: 7 }, recording)
      assert.strictEqual(refused.code, 1)
      assert.match(refused.err, /^lntt: .*does not match the schema/)
      assert.strictEqual((yield* lntt({ kind: 'operator', show: 'profile' }, '{}')).out, '{"role":"developer"}')
      const missing = yield* lntt({ kind: 'operator', show: { key: 'handle' } }, '{}')
      assert.deepStrictEqual([missing.code, missing.err], [1, 'lntt: no handle in the configuration'])
    }),
  )
})

describe('with no configuration', () => {
  it.effect('path, get and validate say so on stderr and exit 1', () =>
    Effect.gen(function* () {
      for (const parsed of [{ kind: 'path' }, { kind: 'get', key: 'project' }, { kind: 'validate' }] as const) {
        const run = yield* lntt(parsed, null)
        assert.deepStrictEqual(
          run,
          { code: 1, out: '', err: 'lntt: no .agents/config.jsonc or .agents/config.yml in /project or above' },
          parsed.kind,
        )
      }
    }),
  )
})

describe('the operator', () => {
  it.effect('sources lists the profiles read, one per line; none with no profile', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* lntt({ kind: 'operator', show: 'sources' }, null), { code: 0, out: '', err: '' })
      const global = `${HOME}/.agents/operator.yml`
      const run = yield* lntt({ kind: 'operator', show: 'sources' }, null, { [global]: 'handle: ada\n' })
      assert.deepStrictEqual(run, { code: 0, out: global, err: '' })
    }),
  )
})

describe('a delivery.review the schema accepts and lntt review refuses', () => {
  it.effect('validates with no warning: it is the first round that refuses it', () =>
    Effect.gen(function* () {
      const run = yield* validate(
        '{ "delivery": { "review": { "reviewers": { "custom": { "with": [{ "kind": "claude", "model": "sonnet" }] } } } } }',
      )
      assert.deepStrictEqual([run.code, run.err], [0, ''])
    }),
  )
})
