import { createHash } from 'node:crypto'
import { assert, describe, it } from '@effect/vitest'
import * as Digest from 'effect/crypto/Digest'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as TestConsole from 'effect/testing/TestConsole'
import { ProjectConfig } from '../config/load.ts'
import { Git } from '../git/git.ts'
import { memoryFileSystem } from '../testing/file-system.ts'
import { migrateOld, move, type PlaceInput, placeOf, resolvePlace } from './place.ts'

const resolving = Layer.mergeAll(Path.layer, Digest.layerWebCrypto)

const input: PlaceInput = {
  common: '/repo/.git',
  main: '/repo',
  slug: undefined,
  operator: undefined,
  project: undefined,
  home: '/home/me',
}

const failure = <A, E>(exit: Exit.Exit<A, E>) => {
  assert.ok(Exit.isFailure(exit), 'it fails')
  return String(Exit.isFailure(exit) ? exit.cause : '')
}

describe('the place', () => {
  it.effect('is the clone’s common git directory when nobody names one', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* resolvePlace(input), {
        dir: '/repo/.git/lntt-review',
        source: 'the git common directory',
      })
    }).pipe(Effect.provide(resolving)),
  )

  it.effect("the operator's place wins over the project's, and a configured place holds a folder per repository", () =>
    Effect.gen(function* () {
      const both = { ...input, slug: 'org/proj', operator: '/mine', project: '/theirs' }
      assert.deepStrictEqual(yield* resolvePlace(both), {
        dir: '/mine/org/proj',
        source: 'the operator profile (review.stateDir)',
      })
      assert.deepStrictEqual(yield* resolvePlace({ ...both, operator: undefined }), {
        dir: '/theirs/org/proj',
        source: 'delivery.review.stateDir',
      })
    }).pipe(Effect.provide(resolving)),
  )

  it.effect('a place with ~ starts at the home; with no origin the repository is keyed by its git directory', () =>
    Effect.gen(function* () {
      const { dir } = yield* resolvePlace({ ...input, operator: '~/store' })
      assert.match(dir, /^\/home\/me\/store\/local\/[0-9a-f]{12}$/)
    }).pipe(Effect.provide(resolving)),
  )

  it.effect(
    'the key of a clone with no origin is the one earlier versions wrote: the first 12 of the SHA-1 of its git directory',
    () =>
      Effect.gen(function* () {
        const sha1 = createHash('sha1').update('/repo/.git').digest('hex').slice(0, 12)
        assert.strictEqual((yield* resolvePlace({ ...input, project: '/store' })).dir, `/store/local/${sha1}`)
      }).pipe(Effect.provide(resolving)),
  )

  it.effect("the project's place, relative, starts at the main checkout", () =>
    Effect.gen(function* () {
      const { dir } = yield* resolvePlace({ ...input, slug: 'org/proj', project: '.git/elsewhere' })
      assert.strictEqual(dir, '/repo/.git/elsewhere/org/proj')
    }).pipe(Effect.provide(resolving)),
  )

  it.effect('a place of ~ alone, and a project place starting with ~/', () =>
    Effect.gen(function* () {
      const named = { ...input, slug: 'org/proj' }
      assert.strictEqual((yield* resolvePlace({ ...named, operator: '~' })).dir, '/home/me/org/proj')
      assert.strictEqual((yield* resolvePlace({ ...named, project: '~/shared' })).dir, '/home/me/shared/org/proj')
    }).pipe(Effect.provide(resolving)),
  )

  it.effect('an origin segment of . or .. leaves no way out of the place', () =>
    Effect.gen(function* () {
      for (const slug of ['../proj', './proj', 'org/..', 'org/.']) {
        const { dir } = yield* resolvePlace({ ...input, slug, project: '/store' })
        assert.match(dir, /^\/store\/local\/[0-9a-f]{12}$/, slug)
      }
      assert.strictEqual(
        (yield* resolvePlace({ ...input, slug: 'org/proj', project: '/store' })).dir,
        '/store/org/proj',
      )
    }).pipe(Effect.provide(resolving)),
  )

  it.effect("the operator's place must be absolute or start with ~, and a place must be a path", () =>
    Effect.gen(function* () {
      const relative = failure(yield* Effect.exit(resolvePlace({ ...input, operator: 'relative/dir' })))
      assert.match(relative, /PlaceInvalid/)
      assert.match(relative, /review\.stateDir must be an absolute path or start with ~: relative\/dir/)
      for (const bad of [3, '', false]) {
        assert.match(
          failure(yield* Effect.exit(resolvePlace({ ...input, project: bad }))),
          /delivery\.review\.stateDir must be a path, not /,
          String(bad),
        )
      }
    }).pipe(Effect.provide(resolving)),
  )
})

describe('moving a file to the place', () => {
  // /other is a filesystem of its own: a rename cannot reach it.
  const setup = () => {
    const fs = memoryFileSystem({ dirs: ['/repo/.git', '/place', '/other/place'], devices: ['/other'] })
    return { fs, layer: fs.layer, ready: fs.put('/repo/.git/old.json', '{"branch":"x"}') }
  }

  it.effect('renames when it can', () => {
    const { fs, layer, ready } = setup()
    return Effect.gen(function* () {
      yield* ready
      yield* move('/repo/.git/old.json', '/place/new.json')
      assert.strictEqual(fs.text('/place/new.json'), '{"branch":"x"}')
      assert.strictEqual(fs.text('/repo/.git/old.json'), undefined)
    }).pipe(Effect.provide(layer))
  })

  it.effect('across filesystems copies beside the destination, renames it in place and removes the source', () => {
    const { fs, layer, ready } = setup()
    return Effect.gen(function* () {
      yield* ready
      yield* move('/repo/.git/old.json', '/other/place/new.json')
      assert.strictEqual(fs.text('/other/place/new.json'), '{"branch":"x"}')
      assert.strictEqual(fs.text('/repo/.git/old.json'), undefined, 'the source is gone, so it is not read again')
      assert.deepStrictEqual(
        [...fs.files.keys()].filter((path) => path.startsWith('/other/')),
        ['/other/place/new.json'],
        'no partial file is left',
      )
    }).pipe(Effect.provide(layer))
  })

  it.effect('any other failure is the caller’s', () => {
    const { fs, layer, ready } = setup()
    return Effect.gen(function* () {
      yield* ready
      const exit = yield* Effect.exit(move('/repo/.git/old.json', '/nowhere/new.json'))
      assert.match(failure(exit), /NotFound/)
      assert.strictEqual(fs.text('/repo/.git/old.json'), '{"branch":"x"}', 'the source stays')
      assert.strictEqual(fs.text('/nowhere/new.json'), undefined)
    }).pipe(Effect.provide(layer))
  })
})

describe('a state in the old place, the worktree’s git directory', () => {
  const GIT_DIR = '/repo/.git'
  const DIR = '/repo/.git/lntt-review'
  const STATE = `${DIR}/state/feat%2F1%2Fx.json`
  const LEDGER = `${DIR}/ledger/feat%2F1%2Fx.json`
  const old = (name = 'lntt-review.json') => `${GIT_DIR}/${name}`
  const setup = (options: { devices?: string[]; dir?: string } = {}) => {
    const fs = memoryFileSystem({ dirs: [GIT_DIR], ...(options.devices ? { devices: options.devices } : {}) })
    const said: string[] = []
    const migrate = migrateOld(GIT_DIR, options.dir ?? DIR, (line) => Effect.sync(() => said.push(line)))
    return { fs, said, migrate: migrate.pipe(Effect.provide(Layer.mergeAll(fs.layer, Path.layer))) }
  }

  it.effect('is read once: moved to the file of the branch it names, with a line saying so', () => {
    const { fs, said, migrate } = setup()
    return Effect.gen(function* () {
      yield* fs.put(old(), JSON.stringify({ branch: 'feat/1/x', round: 1 }))
      yield* fs.put(old('lntt-review-ledger.json'), JSON.stringify({ branch: 'feat/1/x', closed: [] }))
      yield* migrate
      assert.strictEqual(JSON.parse(fs.text(STATE) ?? '').round, 1)
      assert.strictEqual(JSON.parse(fs.text(LEDGER) ?? '').branch, 'feat/1/x')
      assert.deepStrictEqual(said, [
        `moved the state of feat/1/x from ${old()} to ${STATE}`,
        `moved the ledger of feat/1/x from ${old('lntt-review-ledger.json')} to ${LEDGER}`,
      ])
      assert.strictEqual(fs.text(old()) ?? fs.text(old('lntt-review-ledger.json')), undefined, 'never read again')
      said.length = 0
      yield* migrate
      assert.deepStrictEqual(said, [], 'said once')
    })
  })

  it.effect('does not replace a newer one of the place, and a newer one replaces it', () => {
    const { fs, said, migrate } = setup()
    return Effect.gen(function* () {
      yield* fs.put(STATE, JSON.stringify({ branch: 'feat/1/x', round: 2 }))
      yield* fs.put(old(), JSON.stringify({ branch: 'feat/1/x', round: 9 }), 60_000)
      yield* migrate
      assert.deepStrictEqual(said, [`the state of feat/1/x in ${old()} is older than the one in ${STATE}: dropped`])
      assert.strictEqual(JSON.parse(fs.text(STATE) ?? '').round, 2)
      assert.strictEqual(fs.text(old()), undefined)

      yield* fs.put(STATE, JSON.stringify({ branch: 'feat/1/x', round: 2 }), 60_000)
      yield* fs.put(old(), JSON.stringify({ branch: 'feat/1/x', round: 7 }))
      yield* migrate
      assert.strictEqual(JSON.parse(fs.text(STATE) ?? '').round, 7)
    })
  })

  it.effect("at the same time as the place's, the old file is dropped: the place's wins", () => {
    const { fs, said, migrate } = setup()
    return Effect.gen(function* () {
      yield* fs.put(STATE, JSON.stringify({ branch: 'feat/1/x', round: 2 }))
      yield* fs.put(old(), JSON.stringify({ branch: 'feat/1/x', round: 9 }))
      yield* migrate
      assert.strictEqual(JSON.parse(fs.text(STATE) ?? '').round, 2)
      assert.match(said[0] ?? '', /is older than the one in .*: dropped$/)
    })
  })

  it.effect('a file that cannot be read, or that names no branch, is set aside and not migrated', () => {
    const { fs, said, migrate } = setup()
    return Effect.gen(function* () {
      yield* fs.put(old(), '{ cut')
      yield* fs.put(old('lntt-review-ledger.json'), JSON.stringify({ closed: [] }))
      yield* migrate
      assert.deepStrictEqual(said, [
        `${old()} cannot be read: set aside as lntt-review.json.unreadable, not migrated`,
        `${old('lntt-review-ledger.json')} cannot be read: set aside as lntt-review-ledger.json.unreadable, not migrated`,
      ])
      assert.strictEqual(fs.text(old('lntt-review.json.unreadable')), '{ cut')
      assert.strictEqual(fs.text(STATE), undefined)
    })
  })

  it.effect('reaches a place on another filesystem', () => {
    const { fs, migrate } = setup({ devices: ['/store'], dir: '/store/org/proj' })
    return Effect.gen(function* () {
      yield* fs.put(old(), JSON.stringify({ branch: 'feat/1/x' }))
      yield* migrate
      assert.deepStrictEqual(JSON.parse(fs.text('/store/org/proj/state/feat%2F1%2Fx.json') ?? ''), {
        branch: 'feat/1/x',
      })
      assert.strictEqual(fs.text(old()), undefined)
    })
  })
})

describe('the place of a clone', () => {
  it.effect('from git, the configuration and the operator profile; what the first look moves is said on stderr', () => {
    const fs = memoryFileSystem({ dirs: ['/repo/.git', '/home/me'] })
    const layer = Layer.mergeAll(
      fs.layer,
      resolving,
      ProjectConfig.memory({ delivery: { review: { stateDir: '/theirs' } } }),
      Git.memory({
        commonDir: Effect.succeed('/repo/.git'),
        gitDir: Effect.succeed('/repo/.git/worktrees/wt'),
        originUrl: Effect.succeed('https://github.com/org/proj'),
      }),
      TestConsole.layer,
    )
    return Effect.gen(function* () {
      yield* fs.put('/home/me/.agents/operator.jsonc', '{ "review": { "stateDir": "~/mine" } }')
      yield* fs.put('/repo/.git/worktrees/wt/lntt-review.json', JSON.stringify({ branch: 'feat/1/x' }))
      const placed = yield* placeOf('/home/me')
      assert.deepStrictEqual(placed, {
        dir: '/home/me/mine/org/proj',
        source: 'the operator profile (review.stateDir)',
      })
      assert.ok(fs.text('/home/me/mine/org/proj/state/feat%2F1%2Fx.json'))
      assert.match((yield* TestConsole.errorLines).join('\n'), /^lntt review: moved the state of feat\/1\/x from /)
    }).pipe(Effect.provide(layer))
  })

  const placed = (common: string, config: Record<string, unknown>) => {
    const fs = memoryFileSystem({ dirs: [common, '/home/me'] })
    return placeOf('/home/me').pipe(
      Effect.provide(
        Layer.mergeAll(
          fs.layer,
          resolving,
          ProjectConfig.memory(config),
          Git.memory({
            commonDir: Effect.succeed(common),
            gitDir: Effect.succeed(common),
            originUrl: Effect.succeed(''),
          }),
          TestConsole.layer,
        ),
      ),
    )
  }

  it.effect("a project's relative place starts at the main checkout; a bare clone's at its git directory", () =>
    Effect.gen(function* () {
      const relative = { delivery: { review: { stateDir: 'store' } } }
      assert.match((yield* placed('/repo/.git', relative)).dir, /^\/repo\/store\/local\/[0-9a-f]{12}$/)
      assert.match((yield* placed('/srv/repo.git', relative)).dir, /^\/srv\/repo\.git\/store\/local\/[0-9a-f]{12}$/)
    }),
  )
})
