import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import { Git, type GitOperations } from '../git/git.ts'
import { memoryFileSystem } from '../testing/file-system.ts'
import { findConfig, loadConfig, loadOperator, ProjectConfig, projectConfigIn, setConfig } from './load.ts'
import { getValue } from './project.ts'

const ROOT = '/project'

const JSONC = `{
  // The decision logs of this repo.
  "recording": {
    "language": "en", // records are written in English
    "logs": {
      "adr": { "path": "docs/adr" }
    }
  }
}
`

const YAML = `# The decision logs of this repo.
recording:
  language: en # records are written in English
  logs:
    adr:
      path: docs/adr
`

// A file system in memory with `files` in it, git answering `git`, and Path.
function setup(files: Record<string, string> = {}, git: Partial<GitOperations> = {}) {
  const fs = memoryFileSystem({ dirs: [ROOT] })
  const layer = Layer.mergeAll(fs.layer, Path.layer, Git.memory(git))
  const put = (path: string, text: string) => fs.put(path, text)
  return {
    fs,
    put,
    layer,
    ready: Effect.forEach(Object.entries(files), ([path, text]) => put(path, text), { discard: true }),
  }
}

// What an Effect failed with, as its message.
const failure = <A, E>(exit: Exit.Exit<A, E>) => {
  assert.ok(Exit.isFailure(exit), 'it fails')
  return String(Exit.isFailure(exit) ? exit.cause : '')
}

describe('finding the file', () => {
  it.effect('walks up from a subdirectory to .agents/config.jsonc', () => {
    const { layer, ready } = setup({ [`${ROOT}/.agents/config.jsonc`]: JSONC })
    return Effect.gen(function* () {
      yield* ready
      assert.deepStrictEqual(yield* findConfig(`${ROOT}/packages/deep/src`), {
        path: `${ROOT}/.agents/config.jsonc`,
        format: 'jsonc',
      })
    }).pipe(Effect.provide(layer))
  })

  it.effect('finds .agents/config.yml', () => {
    const { layer, ready } = setup({ [`${ROOT}/.agents/config.yml`]: YAML })
    return Effect.gen(function* () {
      yield* ready
      assert.deepStrictEqual(yield* findConfig(ROOT), { path: `${ROOT}/.agents/config.yml`, format: 'yaml' })
    }).pipe(Effect.provide(layer))
  })

  it.effect('refuses a directory that has both formats, naming them', () => {
    const { layer, ready } = setup({ [`${ROOT}/.agents/config.jsonc`]: JSONC, [`${ROOT}/.agents/config.yml`]: YAML })
    return Effect.gen(function* () {
      yield* ready
      const exit = yield* Effect.exit(findConfig(ROOT))
      assert.match(failure(exit), /ConfigInvalid/)
      assert.match(failure(exit), /config\.jsonc and .*config\.yml exist; keep one/)
    }).pipe(Effect.provide(layer))
  })

  it.effect('says so when there is none: a NoConfig, the one failure a command may answer with defaults', () => {
    const { layer } = setup()
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(findConfig(ROOT))
      assert.match(failure(exit), /NoConfig/)
      assert.match(failure(exit), /no \.agents\/config\.jsonc or \.agents\/config\.yml in \/project or above/)
    }).pipe(Effect.provide(layer))
  })
})

describe('a directory that cannot be searched', () => {
  it.effect('holds no file: the walk goes on up', () => {
    const fs = memoryFileSystem({ dirs: [ROOT], unreadable: [`${ROOT}/locked`] })
    return Effect.gen(function* () {
      yield* fs.put(`${ROOT}/.agents/config.jsonc`, JSONC)
      assert.strictEqual((yield* findConfig(`${ROOT}/locked/deep`)).path, `${ROOT}/.agents/config.jsonc`)
    }).pipe(Effect.provide(Layer.mergeAll(fs.layer, Path.layer)))
  })
})

describe('reading and validating', () => {
  it.effect('JSONC and YAML give the same data, comments ignored', () => {
    const { fs, layer, put } = setup()
    return Effect.gen(function* () {
      yield* put(`${ROOT}/.agents/config.jsonc`, JSONC)
      const fromJsonc = (yield* loadConfig(ROOT)).data
      fs.files.delete(`${ROOT}/.agents/config.jsonc`)
      yield* put(`${ROOT}/.agents/config.yml`, YAML)
      assert.deepStrictEqual((yield* loadConfig(ROOT)).data, fromJsonc)
      assert.strictEqual(getValue(fromJsonc, 'recording.logs.adr.path'), 'docs/adr')
    }).pipe(Effect.provide(layer))
  })

  it.effect('accepts the $schema key editors use', () => {
    const { layer, put } = setup()
    return Effect.gen(function* () {
      yield* put(`${ROOT}/.agents/config.jsonc`, `{ "$schema": "../schema.json", "recording": { "logs": {} } }`)
      assert.deepStrictEqual((yield* loadConfig(ROOT)).data.recording, { logs: {} })
    }).pipe(Effect.provide(layer))
  })

  for (const [title, file, text, names] of [
    ['rejects an unknown section, naming it', 'config.jsonc', `{ "recordin": { "logs": {} } }`, /recordin/],
    [
      'rejects a value of the wrong type, naming where',
      'config.yml',
      'recording:\n  logs:\n    adr:\n      path: 42\n',
      /\/recording\/logs\/adr\/path/,
    ],
    [
      'reports a JSONC syntax error instead of reading half a file',
      'config.jsonc',
      '{ "recording": { "logs": { } ',
      /config\.jsonc: /,
    ],
  ] as const) {
    it.effect(`${title}: a ConfigInvalid`, () => {
      const { layer, put } = setup()
      return Effect.gen(function* () {
        yield* put(`${ROOT}/.agents/${file}`, text)
        const message = failure(yield* Effect.exit(loadConfig(ROOT)))
        assert.match(message, /ConfigInvalid/)
        assert.match(message, names)
      }).pipe(Effect.provide(layer))
    })
  }
})

describe('writing keeps the comments', () => {
  for (const [format, file, text, comments] of [
    ['JSONC', 'config.jsonc', JSONC, [/\/\/ The decision logs of this repo\./, /\/\/ records are written in English/]],
    ['YAML', 'config.yml', YAML, [/# The decision logs of this repo\./, /# records are written in English/]],
  ] as const) {
    it.effect(format, () => {
      const { fs, layer, put } = setup()
      const path = `${ROOT}/.agents/${file}`
      return Effect.gen(function* () {
        yield* put(path, text)
        yield* setConfig(ROOT, 'recording.logs.process', { path: 'docs/process' })
        for (const comment of comments) assert.match(fs.text(path) ?? '', comment)
        assert.strictEqual(getValue((yield* loadConfig(ROOT)).data, 'recording.logs.process.path'), 'docs/process')
      }).pipe(Effect.provide(layer))
    })
  }

  it.effect('refuses to write a value the schema rejects, leaving the file as it was', () => {
    const { fs, layer, put } = setup()
    const path = `${ROOT}/.agents/config.jsonc`
    return Effect.gen(function* () {
      yield* put(path, JSONC)
      assert.match(failure(yield* Effect.exit(setConfig(ROOT, 'recording.language', 7))), /ConfigInvalid/)
      assert.strictEqual(fs.text(path), JSONC)
    }).pipe(Effect.provide(layer))
  })
})

describe("the project's configuration as a service", () => {
  it.effect('is the defaults with no file, read once per command; a file that does not validate fails', () => {
    const { layer, put } = setup()
    const service = (dir: string) => ProjectConfig.pipe(Effect.provide(projectConfigIn(dir).pipe(Layer.provide(layer))))
    return Effect.gen(function* () {
      const config = yield* service(`${ROOT}/sub`)
      assert.deepStrictEqual(yield* config.data, {})
      yield* put(`${ROOT}/.agents/config.jsonc`, JSONC)
      assert.deepStrictEqual(yield* config.data, {}, 'read once per command')
      const next = yield* service(`${ROOT}/sub`)
      assert.strictEqual(getValue(yield* next.data, 'recording.language'), 'en', 'found from below, as the loader does')
      yield* put(`${ROOT}/.agents/config.jsonc`, '{ "recordin": {} }')
      assert.match(failure(yield* Effect.exit((yield* service(ROOT)).data)), /ConfigInvalid/)
    }).pipe(Effect.provide(layer))
  })
})

// The operator profile, from a linked worktree of a clone whose main checkout is /main.
const MAIN = '/main'
const HOME = '/home/me'
const inClone = {
  commonDir: Effect.succeed(`${MAIN}/.git`),
  originUrl: Effect.succeed('git@github.com:LunetteOrg/demo.git'),
}

describe('finding the operator profile', () => {
  it.effect("from a linked worktree, reads the main checkout's .agents/local/", () => {
    const path = `${MAIN}/.agents/local/operator.jsonc`
    const { layer, ready } = setup({ [path]: '{ "handle": "ada" // me\n}' }, inClone)
    return Effect.gen(function* () {
      yield* ready
      const { profile, sources } = yield* loadOperator(HOME)
      assert.strictEqual(profile.handle, 'ada')
      assert.deepStrictEqual(sources, [path])
    }).pipe(Effect.provide(layer))
  })

  it.effect('the project profile wins over the global one, key by key', () => {
    const global = `${HOME}/.agents/operator.yml`
    const project = `${MAIN}/.agents/local/operator.jsonc`
    const { layer, ready } = setup(
      {
        [global]: 'language: en\nrole: developer\naccounts:\n  github: ada\n',
        [project]: '{ "role": "product", "accounts": { "google": "ada@example.org" } }',
      },
      inClone,
    )
    return Effect.gen(function* () {
      yield* ready
      const { profile, sources } = yield* loadOperator(HOME)
      assert.deepStrictEqual(profile, {
        language: 'en',
        role: 'product',
        accounts: { github: 'ada', google: 'ada@example.org' },
      })
      assert.deepStrictEqual(sources, [global, project])
    }).pipe(Effect.provide(layer))
  })

  it.effect('without a main-checkout file, falls back to ~/.agents/projects/<org>/<repo>/', () => {
    const path = `${HOME}/.agents/projects/LunetteOrg/demo/operator.yml`
    const { layer, ready } = setup({ [path]: 'handle: ada\n' }, inClone)
    return Effect.gen(function* () {
      yield* ready
      const { profile, sources } = yield* loadOperator(HOME)
      assert.strictEqual(profile.handle, 'ada')
      assert.deepStrictEqual(sources, [path])
    }).pipe(Effect.provide(layer))
  })

  it.effect('with no profile at all, the speaker is a developer', () => {
    const { layer } = setup({}, inClone)
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* loadOperator(HOME), { profile: { role: 'developer' }, sources: [] })
    }).pipe(Effect.provide(layer))
  })

  it.effect('outside a git repository, only the global profile counts', () => {
    // Git.memory fails every operation it is not given, as git does outside a repository.
    const { layer, ready } = setup({ [`${HOME}/.agents/operator.yml`]: 'handle: ada\n' })
    return Effect.gen(function* () {
      yield* ready
      assert.strictEqual((yield* loadOperator(HOME)).profile.handle, 'ada')
    }).pipe(Effect.provide(layer))
  })

  it.effect('refuses both formats in one place, and a profile the schema rejects', () => {
    const { fs, layer, put } = setup({}, inClone)
    return Effect.gen(function* () {
      yield* put(`${MAIN}/.agents/local/operator.jsonc`, '{}')
      yield* put(`${MAIN}/.agents/local/operator.yml`, '{}')
      assert.match(failure(yield* Effect.exit(loadOperator(HOME))), /keep one/)
      fs.files.delete(`${MAIN}/.agents/local/operator.yml`)
      yield* put(`${MAIN}/.agents/local/operator.jsonc`, '{ "confidence": { "git": { "level": 9 } } }')
      const message = failure(yield* Effect.exit(loadOperator(HOME)))
      assert.match(message, /ConfigInvalid/)
      assert.match(message, /operator\.jsonc/)
      assert.match(message, /\/confidence\/git\/level/)
    }).pipe(Effect.provide(layer))
  })
})

describe('review.stateDir', () => {
  it.effect('is a path in the profile, and a project profile wins over the global one', () => {
    const { layer, ready } = setup(
      {
        [`${HOME}/.agents/operator.jsonc`]: '{ "review": { "stateDir": "~/a" } }',
        [`${MAIN}/.agents/local/operator.jsonc`]: '{ "review": { "stateDir": "~/b" } }',
      },
      inClone,
    )
    return Effect.gen(function* () {
      yield* ready
      assert.deepStrictEqual((yield* loadOperator(HOME)).profile.review, { stateDir: '~/b' })
    }).pipe(Effect.provide(layer))
  })

  it.effect('refuses a value that is not a path, and a key the section does not have', () => {
    const { layer, put } = setup({}, inClone)
    return Effect.gen(function* () {
      for (const bad of [
        '{ "review": { "stateDir": 3 } }',
        '{ "review": { "stateDir": "" } }',
        '{ "review": { "dir": "x" } }',
      ]) {
        yield* put(`${MAIN}/.agents/local/operator.jsonc`, bad)
        assert.match(failure(yield* Effect.exit(loadOperator(HOME))), /ConfigInvalid/, bad)
      }
    }).pipe(Effect.provide(layer))
  })
})
