import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as TestClock from 'effect/testing/TestClock'
import { Gh, GhError } from '../gh/gh.ts'
import { Git } from '../git/git.ts'
import { CACHE_FILE, GH_TIMEOUT_MS } from '../refs.ts'
import { memoryFileSystem } from '../testing/file-system.ts'
import { resolveRefs } from './resolve.ts'

const GIT_DIR = '/repo/.git'
const FILE = `${GIT_DIR}/${CACHE_FILE}`
const url = (n: number) => `https://github.com/o/r/issues/${n}`

// A repository whose git directory is GIT_DIR, gh answering the repository o/r and each issue from
// `issues` (an Effect: a title, a refusal, or one that never ends), on an in-memory file system.
function machine(issues: Record<number, Effect.Effect<{ title: string; url: string }, GhError>> = {}) {
  const fs = memoryFileSystem({ dirs: [GIT_DIR] })
  const asked: number[] = []
  const layer = Layer.mergeAll(
    fs.layer,
    Git.memory({
      gitDir: Effect.succeed(GIT_DIR),
      remotes: Effect.succeed('remote.origin.url git@github.com:o/r.git'),
    }),
    Gh.memory({
      repository: Effect.succeed('o/r'),
      issueLink: ({ number }) =>
        Effect.suspend(() => {
          asked.push(number)
          return issues[number] ?? Effect.fail(new GhError({ args: ['api'], output: 'gh: Not Found (HTTP 404)' }))
        }),
    }),
  )
  return { fs, asked, layer }
}

describe('resolveRefs on Effect', () => {
  it.effect('the titles gh gives, written to the cache with the time they were asked, through a renamed file', () => {
    const m = machine({ 1: Effect.succeed({ title: 'One', url: url(1) }) })
    return Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000)
      const out = yield* resolveRefs('#1 and #2')
      assert.strictEqual(out.repository, 'o/r')
      assert.deepStrictEqual(out.refs, [
        { ref: 'o/r#1', title: 'One', url: url(1) },
        { ref: 'o/r#2', title: null, url: null, why: 'unknown' },
      ])
      const written = JSON.parse(m.fs.text(FILE) ?? '')
      assert.deepStrictEqual(written['o/r#1'], { title: 'One', url: url(1), at: 1_000_000 })
      assert.strictEqual(written.repository.name, 'o/r')
      assert.match(written.repository.remotes, /^[0-9a-f]{64}$/)
      assert.deepStrictEqual([...m.fs.files.keys()], [FILE], 'no temporary file left')
      const again = yield* resolveRefs('#1', { cached: true })
      assert.deepStrictEqual(again.refs, [{ ref: 'o/r#1', title: 'One', url: url(1) }])
      assert.deepStrictEqual(m.asked, [1, 2], 'the second call reads the cache only')
    }).pipe(Effect.provide(m.layer))
  })

  it.effect(`a gh that does not answer in ${GH_TIMEOUT_MS} ms: the lookup failed, and its call is interrupted`, () => {
    let interrupted = 0
    const m = machine({ 3: Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => interrupted++))) })
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(resolveRefs('#3'))
      yield* TestClock.adjust(GH_TIMEOUT_MS)
      const out = yield* Fiber.join(fiber)
      assert.deepStrictEqual(out.refs, [{ ref: 'o/r#3', title: null, url: null, why: 'failed' }])
      assert.strictEqual(interrupted, 1)
    }).pipe(Effect.provide(m.layer))
  })

  it.effect('gh missing turns the lookups off; a refusal is read by what gh said', () => {
    const m = machine({
      1: Effect.fail(new GhError({ args: ['api'], output: 'spawn gh ENOENT', missing: true })),
      2: Effect.fail(new GhError({ args: ['api'], output: 'gh: Bad credentials (HTTP 401)' })),
      3: Effect.fail(new GhError({ args: ['api'], output: 'API rate limit exceeded' })),
    })
    return Effect.gen(function* () {
      const out = yield* resolveRefs('#1 #2 #3')
      assert.deepStrictEqual(
        out.refs.map((r) => 'why' in r && r.why),
        ['off', 'off', 'failed'],
      )
    }).pipe(Effect.provide(m.layer))
  })

  it.effect('a cache that cannot be replaced still answers, and leaves no temporary file behind', () => {
    const m = machine({ 1: Effect.succeed({ title: 'One', url: url(1) }) })
    return Effect.gen(function* () {
      yield* m.fs.dir(FILE)
      const out = yield* resolveRefs('#1')
      assert.strictEqual(out.refs[0]?.title, 'One')
      assert.deepStrictEqual([...m.fs.files.keys()], [])
    }).pipe(Effect.provide(m.layer))
  })

  it.effect('outside a repository: no cache, no repository, nothing looked up', () => {
    const m = machine({ 1: Effect.succeed({ title: 'One', url: url(1) }) })
    return Effect.gen(function* () {
      const out = yield* resolveRefs('#1 and o/r#2').pipe(Effect.provide(Git.memory({})))
      assert.strictEqual(out.repository, null)
      assert.deepStrictEqual(out.refs, [{ ref: 'o/r#2', title: null, url: null, why: 'off' }])
      assert.deepStrictEqual(m.asked, [])
    }).pipe(Effect.provide(m.layer))
  })
})
