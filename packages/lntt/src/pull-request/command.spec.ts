import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as TestConsole from 'effect/testing/TestConsole'
import { projectConfigIn } from '../config/load.ts'
import { memoryFileSystem } from '../testing/file-system.ts'
import { block } from './command.ts'

const ROOT = '/project'

// One run of `lntt pr block` from `cwd`, in a project whose configuration is `config` (null:
// none): its exit code, stdout and stderr.
const run = (config: string | null, cwd = ROOT) => {
  const fs = memoryFileSystem({ dirs: [`${ROOT}/src/deep`] })
  return Effect.gen(function* () {
    if (config !== null) yield* fs.put(`${ROOT}/.agents/config.jsonc`, config)
    const code = yield* block
    return { code, out: (yield* TestConsole.logLines).join('\n'), err: (yield* TestConsole.errorLines).join('\n') }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        projectConfigIn(cwd).pipe(Layer.provide(Layer.mergeAll(fs.layer, Path.layer))),
        Layer.fresh(TestConsole.layer),
      ),
    ),
  )
}

const RETRO = JSON.stringify({
  delivery: { pullRequest: { retrospective: { heading: '🔁 Retro', lines: ['Friction', 'Review cost'] } } },
})

describe('lntt pr block', () => {
  it.effect("the empty block of the configuration's labels, found from a folder below the root; exit 0", () =>
    Effect.gen(function* () {
      const expected = '## 🔁 Retro\n<!-- retro:start -->\n- **Friction:**\n- **Review cost:**\n<!-- retro:end -->'
      assert.deepStrictEqual([(yield* run(RETRO)).code, (yield* run(RETRO)).out], [0, expected])
      const below = yield* run(RETRO, `${ROOT}/src/deep`)
      assert.deepStrictEqual([below.code, below.out], [0, expected])
    }),
  )

  it.effect('no configuration is the defaults; one that does not validate is one line and exit 1, no stack', () =>
    Effect.gen(function* () {
      const none = yield* run(null)
      assert.strictEqual(none.code, 0)
      assert.match(none.out, /^## .*\n<!-- retro:start -->\n/)
      const invalid = yield* run('{ "nope": 1 }')
      assert.deepStrictEqual([invalid.code, invalid.out], [1, ''])
      assert.match(invalid.err, /^lntt pr: \/project\/\.agents\/config\.jsonc does not match the schema/)
    }),
  )
})
