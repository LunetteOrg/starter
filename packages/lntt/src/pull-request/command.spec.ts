import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as TestConsole from 'effect/testing/TestConsole'
import { block, ProjectConfig } from './command.ts'

// One run of `lntt pr block` on a configuration loader: its exit code, stdout and stderr.
const run = (load: () => Record<string, unknown>) =>
  Effect.gen(function* () {
    const code = yield* block
    return { code, out: (yield* TestConsole.logLines).join('\n'), err: (yield* TestConsole.errorLines).join('\n') }
  }).pipe(Effect.provideService(ProjectConfig, load), Effect.provide(TestConsole.layer))

describe('lntt pr block', () => {
  it.effect("the empty block of the configuration's labels, exit 0", () =>
    Effect.gen(function* () {
      const retrospective = { heading: '🔁 Retro', lines: ['Friction', 'Review cost'] }
      const r = yield* run(() => ({ delivery: { pullRequest: { retrospective } } }))
      assert.deepStrictEqual(
        [r.code, r.out],
        [0, '## 🔁 Retro\n<!-- retro:start -->\n- **Friction:**\n- **Review cost:**\n<!-- retro:end -->'],
      )
    }),
  )

  it.effect('a configuration the loader refuses is one line and exit 1, no stack', () =>
    Effect.gen(function* () {
      const r = yield* run(() => {
        throw new Error('no .agents/config.jsonc or .agents/config.yml from /x up')
      })
      assert.deepStrictEqual(
        [r.code, r.out, r.err],
        [1, '', 'lntt pr: no .agents/config.jsonc or .agents/config.yml from /x up'],
      )
    }),
  )
})
