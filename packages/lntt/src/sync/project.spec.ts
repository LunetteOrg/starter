import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import { managedBlock } from '../agents.ts'
import { AUTOMATED_MARKER, automatedLine } from '../automated.ts'
import { SKILL_DIRS } from '../skills.ts'
import { memoryFileSystem } from '../testing/file-system.ts'
import { BLOCK_SOURCE, PACKAGE, PACKAGE_FILES, SKILLS, stubOf } from '../testing/package.ts'
import {
  agentsBlockHeld,
  guide,
  installedSkills,
  PackageDir,
  settingsOf,
  sharedSkills,
  stubFolders,
  syncAgentsBlock,
  syncProject,
  syncSkills,
  workflowResults,
} from './project.ts'

const ROOT = '/project'

// The package and a project with its configuration, in memory; `run` gives an Effect the
// services, the package at PACKAGE.
function world() {
  const memory = memoryFileSystem({ dirs: [ROOT] })
  for (const [path, text] of Object.entries(PACKAGE_FILES)) memory.files.set(path, { text, mtime: 0 })
  for (const path of Object.keys(PACKAGE_FILES)) Effect.runSync(memory.dir(path.slice(0, path.lastIndexOf('/'))))
  const put = (path: string, text: string) => memory.put(`${ROOT}/${path}`, text)
  const text = (path: string) => memory.text(`${ROOT}/${path}`)
  const names = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readDirectory(`${ROOT}/${path}`))
  const exists = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(`${ROOT}/${path}`))
  const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(Effect.provide(Layer.mergeAll(memory.layer, Path.layer)), Effect.provideService(PackageDir, PACKAGE))
  return { memory, put, text, names, exists, run }
}

// The skills that are not as lntt sync writes them, as `state path`.
const off = (root = ROOT) =>
  Effect.map(installedSkills(root), (skills) =>
    skills.filter((s) => s.state !== 'ok').map((s) => `${s.state} ${s.path}`),
  )

describe('the shared skills of the package', () => {
  it.effect('are the folders of skills/ holding a SKILL.md, sorted', () => {
    const w = world()
    return w.run(
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* sharedSkills, [...SKILLS])
      }),
    )
  })

  it.effect(
    'a guide is the SKILL.md of the package, after the folder its links start from; none for another name',
    () => {
      const w = world()
      return w.run(
        Effect.gen(function* () {
          assert.strictEqual(
            yield* guide('decisions'),
            `<!-- lntt guide decisions: relative links start from ${PACKAGE}/skills/decisions -->\n\n${PACKAGE_FILES[`${PACKAGE}/skills/decisions/SKILL.md`]}`,
          )
          assert.strictEqual(yield* guide('drafts'), null, 'a folder with no SKILL.md is no skill')
          assert.strictEqual(yield* guide('nope'), null)
        }),
      )
    },
  )
})

describe('the stubs lntt sync writes', () => {
  it.effect('a stub for every skill in .agents/skills and .claude/skills, alone in its folder', () => {
    const w = world()
    return w.run(
      Effect.gen(function* () {
        yield* syncSkills(ROOT)
        assert.deepStrictEqual(SKILL_DIRS, ['.agents/skills', '.claude/skills'])
        for (const dir of SKILL_DIRS) {
          assert.deepStrictEqual(yield* w.names(dir), [...SKILLS])
          for (const name of SKILLS) {
            assert.deepStrictEqual(yield* w.names(`${dir}/${name}`), ['SKILL.md'])
            assert.strictEqual(w.text(`${dir}/${name}/SKILL.md`), stubOf(name))
          }
        }
      }),
    )
  })

  it.effect('an edited stub is put back, the stubs of skills gone removed, and the project skills left alone', () => {
    const w = world()
    return w.run(
      Effect.gen(function* () {
        yield* syncSkills(ROOT)
        yield* w.put('.claude/skills/decisions/SKILL.md', `${stubOf('decisions')}One more rule.\n`)
        yield* w.put('.agents/skills/decisions/extra.md', 'extra\n')
        yield* w.put('.agents/skills/decisions/.DS_Store', '')
        yield* w.put('.claude/skills/review/references/deep/notes.md', 'nested\n')
        yield* w.put('.claude/skills/gone/SKILL.md', stubOf('decisions').replaceAll('decisions', 'gone'))
        yield* w.put('.claude/skills/issues/SKILL.md', 'our own skill\n')
        yield* syncSkills(ROOT)
        assert.strictEqual(w.text('.claude/skills/decisions/SKILL.md'), stubOf('decisions'))
        assert.deepStrictEqual(yield* w.names('.agents/skills/decisions'), ['SKILL.md'], 'extra and hidden files go')
        assert.deepStrictEqual(yield* w.names('.claude/skills/review'), ['SKILL.md'], 'nested folders go')
        assert.isFalse(yield* w.exists('.claude/skills/gone'))
        assert.strictEqual(w.text('.claude/skills/issues/SKILL.md'), 'our own skill\n')
        const once = new Map(w.memory.files)
        yield* syncSkills(ROOT)
        assert.deepStrictEqual(
          [...w.memory.files].map(([path, file]) => [path, file.text]),
          [...once].map(([path, file]) => [path, file.text]),
          'a second sync changes nothing',
        )
      }),
    )
  })

  it.effect('a project skill with a shared name is a clash: nothing is written, and the check names it', () => {
    const w = world()
    return w.run(
      Effect.gen(function* () {
        yield* w.put('.claude/skills/review/SKILL.md', 'our own review\n')
        const refused = yield* Effect.flip(syncSkills(ROOT))
        assert.strictEqual(refused._tag, 'SyncFailed')
        assert.match(
          refused.message,
          /^\.claude\/skills\/review: a skill of the project's own with the name of a shared skill; rename it, then run pnpm exec lntt sync$/,
        )
        assert.isFalse(yield* w.exists('.agents/skills/review'), 'nothing written')
        assert.strictEqual(w.text('.claude/skills/review/SKILL.md'), 'our own review\n')
        assert.include(yield* off(), 'clash .claude/skills/review')
        yield* w.put('.agents/skills/decisions/notes.md', 'no SKILL.md, still ours\n')
        assert.include(yield* off(), 'clash .agents/skills/decisions')
        assert.match(
          (yield* Effect.flip(syncSkills(ROOT))).message,
          /^\.agents\/skills\/decisions, \.claude\/skills\/review: /,
        )
        assert.strictEqual(w.text('.agents/skills/decisions/notes.md'), 'no SKILL.md, still ours\n')
      }),
    )
  })

  it.effect('an empty folder, or one holding hidden files only, is free: sync writes the stub in it', () => {
    const w = world()
    return w.run(
      Effect.gen(function* () {
        yield* w.memory.dir(`${ROOT}/.agents/skills/review`)
        yield* w.put('.claude/skills/review/.DS_Store', '')
        yield* syncSkills(ROOT)
        assert.strictEqual(w.text('.agents/skills/review/SKILL.md'), stubOf('review'))
        assert.strictEqual(w.text('.claude/skills/review/SKILL.md'), stubOf('review'))
      }),
    )
  })
})

describe('the skills the check reads', () => {
  it.effect('every stub missing from either directory is named', () => {
    const w = world()
    return w.run(
      Effect.gen(function* () {
        assert.deepStrictEqual(
          yield* off(),
          SKILL_DIRS.flatMap((dir) => SKILLS.map((name) => `missing ${dir}/${name}`)),
        )
      }),
    )
  })

  it.effect('after sync every skill is in step, the project skills beside the stubs ignored', () => {
    const w = world()
    return w.run(
      Effect.gen(function* () {
        yield* syncSkills(ROOT)
        yield* w.put('.agents/skills/ours/SKILL.md', 'ours\n')
        assert.deepStrictEqual(yield* off(), [])
        assert.strictEqual((yield* installedSkills(ROOT)).length, SKILL_DIRS.length * SKILLS.length)
      }),
    )
  })

  it.effect(
    'an edited stub, a file added beside one, and a stub of a skill the package does not have are named',
    () => {
      const w = world()
      return w.run(
        Effect.gen(function* () {
          yield* syncSkills(ROOT)
          yield* w.put('.claude/skills/commit-message/SKILL.md', `${stubOf('commit-message')}One more rule.\n`)
          yield* w.put('.agents/skills/decisions/notes.md', 'added\n')
          yield* w.put('.agents/skills/gone/SKILL.md', stubOf('decisions').replaceAll('decisions', 'gone'))
          assert.deepStrictEqual(yield* off(), [
            'edited .agents/skills/decisions',
            'edited .claude/skills/commit-message',
            'unknown .agents/skills/gone',
          ])
        }),
      )
    },
  )

  it.effect('a stub checked out with CRLF line endings, or next to a hidden file, is unedited', () => {
    const w = world()
    return w.run(
      Effect.gen(function* () {
        yield* syncSkills(ROOT)
        yield* w.put('.claude/skills/review/SKILL.md', stubOf('review').replaceAll('\n', '\r\n'))
        yield* w.put('.agents/skills/review/.DS_Store', '')
        assert.deepStrictEqual(yield* off(), [])
      }),
    )
  })

  it.effect(
    'a project skill that quotes the marker below its frontmatter is not a stub: sync and check leave it alone',
    () => {
      const w = world()
      return w.run(
        Effect.gen(function* () {
          const text = `---\nname: mine\ndescription: ours\n---\n# Mine\n\n${stubOf('review').split('\n')[4]}\n`
          yield* w.put('.agents/skills/mine/SKILL.md', text)
          yield* syncSkills(ROOT)
          assert.deepStrictEqual(yield* off(), [])
          assert.strictEqual(w.text('.agents/skills/mine/SKILL.md'), text)
        }),
      )
    },
  )

  it.effect('the stub folders are told apart from the project skills beside them', () => {
    const w = world()
    return w.run(
      Effect.gen(function* () {
        yield* syncSkills(ROOT)
        yield* w.put('.agents/skills/gone/SKILL.md', stubOf('decisions').replaceAll('decisions', 'gone'))
        yield* w.put('.claude/skills/issues/SKILL.md', 'our own skill\n')
        assert.deepStrictEqual(yield* stubFolders(ROOT), [
          ...[...SKILLS, 'gone'].sort().map((n) => `.agents/skills/${n}`),
          ...SKILLS.map((n) => `.claude/skills/${n}`),
        ])
      }),
    )
  })

  it.effect('a skill of the package with no frontmatter gives no stub: the check cannot run', () => {
    const w = world()
    return w.run(
      Effect.gen(function* () {
        yield* w.memory.put(`${PACKAGE}/skills/review/SKILL.md`, '# Review\n')
        const failed = yield* Effect.flip(installedSkills(ROOT))
        assert.strictEqual(failed._tag, 'SyncFailed')
        assert.strictEqual(failed.message, 'skills/review/SKILL.md of @lntt/lntt has no frontmatter')
      }),
    )
  })
})

describe('the managed block of AGENTS.md', () => {
  it.effect('sync writes it from the package; the check holds it until a hand edit, or with no AGENTS.md', () => {
    const w = world()
    return w.run(
      Effect.gen(function* () {
        assert.isFalse(yield* agentsBlockHeld(ROOT))
        yield* w.put('AGENTS.md', '# Mine\n')
        assert.isFalse(yield* agentsBlockHeld(ROOT))
        yield* syncAgentsBlock(ROOT)
        assert.strictEqual(w.text('AGENTS.md'), `${managedBlock(BLOCK_SOURCE)}\n# Mine\n`)
        assert.isTrue(yield* agentsBlockHeld(ROOT))
        yield* w.put('AGENTS.md', (w.text('AGENTS.md') as string).replace('Give criteria', 'Give options'))
        assert.isFalse(yield* agentsBlockHeld(ROOT))
      }),
    )
  })
})

describe('lntt sync on a whole project', () => {
  const workflow = (line: string) => `name: CI\njobs:\n  ci:\n    env:\n      ${line}\n`
  const data = {
    delivery: { automated: [{ author: 'dependabot[bot]', branch: 'dependabot/', runs: 'always', ci: 'full' }] },
  }

  it.effect('writes the stubs, the block, the settings and the workflow lines; a second sync changes nothing', () => {
    const w = world()
    return w.run(
      Effect.gen(function* () {
        yield* w.put('.github/workflows/ci.yml', workflow(`AUTOMATED: '[]' ${AUTOMATED_MARKER}`))
        yield* w.put('.github/workflows/other.yml', 'name: Other\n')
        assert.strictEqual((yield* workflowResults(ROOT, data))[0]?.status, 'FAIL')
        yield* syncProject(ROOT, data)
        assert.deepStrictEqual(yield* off(), [])
        assert.isTrue(yield* agentsBlockHeld(ROOT))
        assert.deepStrictEqual(
          (yield* settingsOf(ROOT)).filter((e) => e.state !== 'ok'),
          [],
        )
        assert.strictEqual(
          w.text('.github/workflows/ci.yml'),
          workflow(automatedLine('AUTOMATED', data.delivery.automated as never)),
        )
        assert.strictEqual(w.text('.github/workflows/other.yml'), 'name: Other\n')
        assert.deepStrictEqual(
          (yield* workflowResults(ROOT, data)).map((r) => [r.status, r.path]),
          [['PASS', '.github/workflows/ci.yml']],
        )
        const once = [...w.memory.files].map(([path, file]) => [path, file.text])
        yield* syncProject(ROOT, data)
        assert.deepStrictEqual(
          [...w.memory.files].map(([path, file]) => [path, file.text]),
          once,
        )
      }),
    )
  })

  it.effect('with no workflows there is nothing to sync, and nothing for the check to run', () => {
    const w = world()
    return w.run(
      Effect.gen(function* () {
        yield* syncProject(ROOT, data)
        assert.isFalse(yield* w.exists('.github'))
        assert.deepStrictEqual(
          (yield* workflowResults(ROOT, data)).map((r) => r.status),
          ['NOT RUN'],
        )
      }),
    )
  })

  it.effect('a settings file that is not the shape Claude Code reads stops the sync, the file kept', () => {
    const w = world()
    return w.run(
      Effect.gen(function* () {
        yield* w.put('.claude/settings.json', '{ "enabledPlugins": "x" }\n')
        const refused = yield* Effect.flip(syncProject(ROOT, data))
        assert.strictEqual(refused._tag, 'SyncFailed')
        assert.match(refused.message, /not JSON, or not the shape Claude Code reads/)
        assert.strictEqual(w.text('.claude/settings.json'), '{ "enabledPlugins": "x" }\n')
      }),
    )
  })
})
