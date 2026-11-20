import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as TestConsole from 'effect/testing/TestConsole'
import { memoryFileSystem } from '../testing/file-system.ts'
import { block } from './command.ts'

const ROOT = '/project'

// One run of `lntt pr block` in a project whose configuration is `config` (null: none): its exit
// code, stdout and stderr.
const run = (config: string | null) => {
  const fs = memoryFileSystem({ dirs: [ROOT] })
  return Effect.gen(function* () {
    if (config !== null) yield* fs.put(`${ROOT}/.agents/config.jsonc`, config)
    const code = yield* block(ROOT)
    return { code, out: (yield* TestConsole.logLines).join('\n'), err: (yield* TestConsole.errorLines).join('\n') }
  }).pipe(Effect.provide(Layer.mergeAll(fs.layer, Path.layer, Layer.fresh(TestConsole.layer))))
}

describe('lntt pr block', () => {
  it.effect("the empty block of the configuration's labels, exit 0", () =>
    Effect.gen(function* () {
      const retrospective = { heading: '🔁 Retro', lines: ['Friction', 'Review cost'] }
      const r = yield* run(JSON.stringify({ delivery: { pullRequest: { retrospective } } }))
      assert.deepStrictEqual(
        [r.code, r.out],
        [0, '## 🔁 Retro\n<!-- retro:start -->\n- **Friction:**\n- **Review cost:**\n<!-- retro:end -->'],
      )
    }),
  )

  it.effect('no configuration, or one that does not validate, is one line and exit 1, no stack', () =>
    Effect.gen(function* () {
      const none = yield* run(null)
      assert.deepStrictEqual([none.code, none.out], [1, ''])
      assert.match(none.err, /^lntt pr: no \.agents\/config\.jsonc or \.agents\/config\.yml in \/project or above$/)
      const invalid = yield* run('{ "nope": 1 }')
      assert.strictEqual(invalid.code, 1)
      assert.match(invalid.err, /^lntt pr: \/project\/\.agents\/config\.jsonc does not match the schema/)
    }),
  )
})
