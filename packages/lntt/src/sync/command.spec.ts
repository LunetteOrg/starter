import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as TestConsole from 'effect/testing/TestConsole'
import { memoryFileSystem } from '../testing/file-system.ts'
import { PACKAGE, PACKAGE_FILES, SKILLS, stubOf } from '../testing/package.ts'
import { command, type SyncCommand } from './command.ts'
import { PackageDir } from './project.ts'

const ROOT = '/project'

// One run of `lntt sync` or `lntt guide` on a project whose files are `files` (null: no
// configuration): its exit code, stdout, stderr and the file system after it.
const lntt = (parsed: SyncCommand, files: Record<string, string> | null = { '.agents/config.jsonc': '{}' }) => {
  const memory = memoryFileSystem({ dirs: [ROOT] })
  for (const [path, text] of Object.entries(PACKAGE_FILES)) memory.files.set(path, { text, mtime: 0 })
  return Effect.gen(function* () {
    for (const path of Object.keys(PACKAGE_FILES)) yield* memory.dir(path.slice(0, path.lastIndexOf('/')))
    for (const [path, text] of Object.entries(files ?? {})) yield* memory.put(`${ROOT}/${path}`, text)
    const code = yield* command(parsed)
    const out = (yield* TestConsole.logLines).join('\n')
    const err = (yield* TestConsole.errorLines).join('\n')
    return { code, out, err, text: (path: string) => memory.text(`${ROOT}/${path}`) }
  }).pipe(
    Effect.provide(Layer.mergeAll(memory.layer, Path.layer, Layer.fresh(TestConsole.layer))),
    Effect.provideService(PackageDir, PACKAGE),
  )
}

describe('lntt sync', () => {
  it.effect('from a subfolder of the project, writes on its root, where its configuration is', () =>
    Effect.gen(function* () {
      const run = yield* lntt(
        { kind: 'sync', cwd: `${ROOT}/packages/x` },
        {
          '.agents/config.jsonc': '{}',
          'packages/x/index.ts': '',
        },
      )
      assert.deepStrictEqual([run.code, run.out, run.err], [0, '', ''])
      assert.strictEqual(run.text('.agents/skills/decisions/SKILL.md'), stubOf('decisions'))
      assert.isString(run.text('AGENTS.md'))
      assert.isString(run.text('.claude/settings.json'))
      assert.isUndefined(run.text('packages/x/AGENTS.md'))
    }),
  )

  it.effect('a clash with a project skill exits 1 in one line, and writes nothing, nor the managed block', () =>
    Effect.gen(function* () {
      const run = yield* lntt(
        { kind: 'sync', cwd: ROOT },
        {
          '.agents/config.jsonc': '{}',
          '.claude/skills/review/SKILL.md': 'our own review\n',
          '.agents/skills/decisions/notes.md': 'ours\n',
        },
      )
      assert.strictEqual(run.code, 1)
      assert.match(
        run.err,
        /^lntt: \.agents\/skills\/decisions, \.claude\/skills\/review: a skill of the project's own/,
      )
      assert.notInclude(run.err, '\n')
      assert.isUndefined(run.text('AGENTS.md'))
      assert.isUndefined(run.text('.agents/skills/review/SKILL.md'))
    }),
  )

  it.effect('a configuration that does not validate, or none, exits 1 in one line before anything is written', () =>
    Effect.gen(function* () {
      const invalid = yield* lntt({ kind: 'sync', cwd: ROOT }, { '.agents/config.jsonc': '{ "nope": 1 }' })
      assert.strictEqual(invalid.code, 1)
      assert.match(invalid.err, /^lntt: \/project\/\.agents\/config\.jsonc does not match the schema/)
      assert.isUndefined(invalid.text('AGENTS.md'))
      const none = yield* lntt({ kind: 'sync', cwd: ROOT }, null)
      assert.strictEqual(none.code, 1)
      assert.match(none.err, /^lntt: /)
    }),
  )
})

describe('lntt guide', () => {
  it.effect('alone lists the shared skills, one per line', () =>
    Effect.gen(function* () {
      const run = yield* lntt({ kind: 'guide' })
      assert.deepStrictEqual([run.code, run.out], [0, SKILLS.join('\n')])
    }),
  )

  it.effect('prints a skill’s guide after the folder its links start from', () =>
    Effect.gen(function* () {
      const run = yield* lntt({ kind: 'guide', name: 'review' })
      assert.strictEqual(run.code, 0)
      assert.strictEqual(
        `${run.out}\n`,
        `<!-- lntt guide review: relative links start from ${PACKAGE}/skills/review -->\n\n${PACKAGE_FILES[`${PACKAGE}/skills/review/SKILL.md`]}`,
      )
    }),
  )

  it.effect('fails on a skill the package does not have, naming the ones it has', () =>
    Effect.gen(function* () {
      const run = yield* lntt({ kind: 'guide', name: 'nope' })
      assert.deepStrictEqual([run.code, run.out], [1, ''])
      assert.strictEqual(run.err, 'lntt guide: no skill nope; the skills are commit-message, decisions, review')
    }),
  )
})
