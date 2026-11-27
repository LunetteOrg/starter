import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { Git, GitError, type GitOperations } from '../git/git.ts'
import { changedAgainst, localEvent } from './event.ts'

// A clone on feat/x, with origin/main fetched and src/a.ts changed against it.
const clone = (answers: Partial<GitOperations> = {}) =>
  Git.memory({
    branch: Effect.succeed('feat/x'),
    verify: (rev) =>
      Effect.succeed(rev === 'HEAD' ? 'c0ffee' : ['origin/main', 'refs/heads/topic'].includes(rev) ? rev : null),
    changed: (range) => Effect.succeed(range === 'origin/main...HEAD' ? ['src/a.ts'] : []),
    originUrl: Effect.succeed('git@github.com:acme/app.git'),
    originHead: Effect.succeed('origin/main'),
    ...answers,
  })

describe('localEvent', () => {
  it.effect('a pull request of the branch into the base, diffed from its remote ref', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* localEvent('pull_request', 'main'), {
        name: 'pull_request',
        base: 'main',
        head: 'feat/x',
        sha: 'c0ffee',
        baseRef: 'origin/main',
        changed: ['src/a.ts'],
        repository: 'acme/app',
        defaultBranch: 'main',
      })
    }).pipe(Effect.provide(clone())),
  )

  it.effect('the resolved base ref wins; a base with no local ref leaves the changed files unknown', () =>
    Effect.gen(function* () {
      const given = yield* localEvent('pull_request', 'candidate/3', { baseRef: 'origin/main' })
      assert.deepStrictEqual([given.baseRef, given.changed], ['origin/main', ['src/a.ts']])
      const none = yield* localEvent('pull_request', 'nowhere')
      assert.deepStrictEqual([none.baseRef, none.changed], [null, null])
    }).pipe(Effect.provide(clone())),
  )

  it.effect('a push of a commit already on the base brings its last commit', () =>
    Effect.gen(function* () {
      const event = yield* localEvent('push', 'main')
      assert.deepStrictEqual(event.changed, ['src/b.ts'])
    }).pipe(
      Effect.provide(clone({ changed: (range) => Effect.succeed(range === 'HEAD^...HEAD' ? ['src/b.ts'] : []) })),
    ),
  )

  it.effect("a detached HEAD at a candidate's head is that candidate; with no prefix it stays HEAD", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        (yield* localEvent('pull_request', 'main', { candidatePrefix: 'candidate/' })).head,
        'candidate/3',
      )
      assert.strictEqual((yield* localEvent('pull_request', 'main')).head, 'HEAD')
    }).pipe(
      Effect.provide(
        clone({
          branch: Effect.succeed('HEAD'),
          pointingAt: () => Effect.succeed(['refs/remotes/origin/candidate/2', 'refs/remotes/origin/candidate/3']),
        }),
      ),
    ),
  )

  it.effect('what git cannot answer reads as unknown: no repository off GitHub, main for the default branch', () =>
    Effect.gen(function* () {
      const event = yield* localEvent('pull_request', 'main')
      assert.deepStrictEqual([event.head, event.sha, event.repository, event.defaultBranch], ['HEAD', '', null, 'main'])
    }).pipe(
      Effect.provide(
        clone({
          branch: Effect.fail(new GitError({ args: ['rev-parse'], output: 'not a git repository' })),
          verify: () => Effect.succeed(null),
          originUrl: Effect.succeed('https://gitlab.com/acme/app.git'),
          originHead: Effect.succeed(null),
        }),
      ),
    ),
  )
})

describe('changedAgainst', () => {
  it.effect("the files changed against a branch's local ref, its remote copy first; null without one", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* changedAgainst('main'), ['src/a.ts'])
      assert.strictEqual(yield* changedAgainst('nowhere'), null)
    }).pipe(Effect.provide(clone())),
  )
})
