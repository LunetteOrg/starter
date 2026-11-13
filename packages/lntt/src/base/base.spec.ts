import { assert, describe, it } from '@effect/vitest'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Gh, GhError, type GhOperations } from '../gh/gh.ts'
import { Git, GitError } from '../git/git.ts'
import { clone } from '../testing/repository.ts'
import {
  type BaseLookup,
  candidateAt,
  githubCandidate,
  localRef,
  projectBase,
  remoteRef,
  repositoryDefault,
  resolveBase,
} from './base.ts'

const CANDIDATE = { base: 'main', prefix: 'candidate/' }

const setup = () => {
  const c = clone()
  const resolve = (over: Partial<BaseLookup<unknown, never>>) =>
    resolveBase({ candidate: CANDIDATE, openCandidate: Effect.succeed('candidate/13'), for: 'head', ...over }).pipe(
      Effect.provide(c.layer()),
    )
  return { c, resolve }
}

// An openCandidate that records being asked.
const asking = () => {
  const seen = { asked: false }
  const openCandidate = Effect.sync(() => {
    seen.asked = true
    return 'candidate/13' as string | null
  })
  return { seen, openCandidate }
}

describe('the base of a branch', () => {
  it.effect('with no candidate: origin/main, never the stale local main, and GitHub is not asked', () =>
    Effect.gen(function* () {
      const { c, resolve } = setup()
      c.switch('feat/6/x', 'origin/main')
      const { seen, openCandidate } = asking()
      const base = yield* resolve({ candidate: null, openCandidate })
      assert.deepStrictEqual([base.branch, base.ref], ['main', 'origin/main'])
      assert.strictEqual(seen.asked, false, 'GitHub asked with no delivery.candidate')
      assert.match(base.reason, /no delivery\.candidate/)
    }),
  )

  it.effect('with no candidate open: origin/main', () =>
    Effect.gen(function* () {
      const base = yield* setup().resolve({ openCandidate: Effect.succeed(null), for: 'new' })
      assert.deepStrictEqual([base.branch, base.ref], ['main', 'origin/main'])
    }),
  )

  it.effect('a new branch starts on the open candidate', () =>
    Effect.gen(function* () {
      const base = yield* setup().resolve({ for: 'new' })
      assert.deepStrictEqual([base.branch, base.ref], ['candidate/13', 'origin/candidate/13'])
    }),
  )

  it.effect('a branch that descends from the open candidate: the candidate, from the fork point', () =>
    Effect.gen(function* () {
      const { c, resolve } = setup()
      c.switch('feat/5/x', 'origin/candidate/13')
      c.commit('mine')
      const base = yield* resolve({})
      assert.deepStrictEqual([base.branch, base.ref], ['candidate/13', c.candidate])
    }),
  )

  it.effect('a branch started on origin/main while a candidate is open: origin/main', () =>
    Effect.gen(function* () {
      const { c, resolve } = setup()
      c.switch('feat/6/x', 'origin/main')
      c.commit('mine')
      const base = yield* resolve({})
      assert.deepStrictEqual([base.branch, base.ref], ['main', 'origin/main'])
    }),
  )

  it.effect("the candidate's own head goes into main", () =>
    Effect.gen(function* () {
      const { c, resolve } = setup()
      c.detach('origin/candidate/13')
      const base = yield* resolve({})
      assert.deepStrictEqual([base.branch, base.ref], ['main', 'origin/main'])
    }),
  )

  it.effect('a branch just started on the candidate, at its head with no commit yet: the candidate', () =>
    Effect.gen(function* () {
      const { c, resolve } = setup()
      c.switch('feat/5/x', 'origin/candidate/13')
      const base = yield* resolve({})
      assert.strictEqual(base.branch, 'candidate/13')
    }),
  )

  it.effect('a hotfix starts on origin/main, even with a candidate open, and GitHub is not asked', () =>
    Effect.gen(function* () {
      const { seen, openCandidate } = asking()
      const base = yield* setup().resolve({ for: 'hotfix', openCandidate })
      assert.deepStrictEqual([base.branch, base.ref], ['main', 'origin/main'])
      assert.strictEqual(seen.asked, false, 'GitHub asked for a hotfix')
      assert.match(base.reason, /hotfix/)
    }),
  )

  it.effect('GitHub unreachable: origin/main, and the reason says the candidate is unknown', () =>
    Effect.gen(function* () {
      const base = yield* setup().resolve({ for: 'new', openCandidate: Effect.fail(new Error('gh: not found')) })
      assert.deepStrictEqual([base.branch, base.ref], ['main', 'origin/main'])
      assert.match(base.reason, /open candidate is unknown \(gh: not found\)/)
      assert.match(base.warning ?? '', /give --base/)
    }),
  )

  it.effect('the local branch named after the open candidate is the candidate itself: main', () =>
    Effect.gen(function* () {
      const { c, resolve } = setup()
      c.switch('candidate/13', 'origin/candidate/13')
      c.commit('squashed here')
      const base = yield* resolve({})
      assert.deepStrictEqual([base.branch, base.ref], ['main', 'origin/main'])
    }),
  )

  it.effect('a base not fetched is an error that says to fetch, not the local branch', () =>
    Effect.gen(function* () {
      const { c, resolve } = setup()
      c.ref('refs/heads/candidate/14', 'HEAD')
      const error = yield* Effect.flip(resolve({ for: 'new', openCandidate: Effect.succeed('candidate/14') }))
      assert.strictEqual(error._tag, 'BaseError')
      assert.match(error.message, /no origin\/candidate\/14.*git fetch origin/)
    }),
  )

  it.effect('a branch with no history in common with the candidate does not descend from it: origin/main', () =>
    Effect.gen(function* () {
      const { c, resolve } = setup()
      c.switch('feat/7/x')
      c.commit('orphan', null)
      const base = yield* resolve({})
      assert.deepStrictEqual([base.branch, base.ref], ['main', 'origin/main'])
      assert.match(base.reason, /does not descend from the open candidate candidate\/13/)
    }),
  )
})

describe('the base of a branch, when git cannot find the fork point', () => {
  it.effect('a merge-base that fails for another reason than "no common history" is its GitError', () =>
    Effect.gen(function* () {
      const { c, resolve } = setup()
      c.switch('feat/8/x', 'origin/candidate/13')
      c.brokenMergeBase()
      const error = yield* Effect.flip(resolve({}))
      assert.strictEqual(error._tag, 'GitError')
      assert.match(error.message, /merge-base.*fatal: Not a valid object name/)
    }),
  )
})

describe('the candidate at a detached HEAD', () => {
  it.effect('is the candidate whose origin/ ref points at it; none for another commit', () =>
    Effect.gen(function* () {
      const c = clone()
      c.detach('origin/candidate/13')
      assert.strictEqual(yield* candidateAt('candidate/').pipe(Effect.provide(c.layer())), 'candidate/13')
      c.detach('origin/main')
      assert.strictEqual(yield* candidateAt('candidate/').pipe(Effect.provide(c.layer())), null)
    }),
  )

  it.effect(
    'the highest by number when several point at it, and names past the prefix that are no number are not candidates',
    () =>
      Effect.gen(function* () {
        const c = clone()
        for (const name of ['9', '13', 'x']) c.ref(`refs/remotes/origin/rc/${name}`, 'origin/candidate/13')
        c.detach('origin/candidate/13')
        assert.strictEqual(yield* candidateAt('rc/').pipe(Effect.provide(c.layer())), 'rc/13')
        c.ref('refs/remotes/origin/rc/13', null)
        c.ref('refs/remotes/origin/rc/9', null)
        assert.strictEqual(yield* candidateAt('rc/').pipe(Effect.provide(c.layer())), null)
      }),
  )
})

describe('the candidate at a detached HEAD, when git cannot list the refs', () => {
  it.effect('is the GitError, not "no candidate"', () =>
    Effect.gen(function* () {
      const failing = Git.memory({
        pointingAt: () => Effect.fail(new GitError({ args: ['for-each-ref'], output: 'fatal: bad object' })),
      })
      const error = yield* Effect.flip(candidateAt('candidate/').pipe(Effect.provide(failing)))
      assert.strictEqual(error._tag, 'GitError')
      assert.strictEqual(error.message, 'git for-each-ref failed: fatal: bad object')
    }),
  )
})

describe('the refs of the base', () => {
  it.effect("the default branch is origin/HEAD's, else main", () =>
    Effect.gen(function* () {
      const c = clone()
      c.originHead('origin/trunk')
      assert.strictEqual(yield* repositoryDefault.pipe(Effect.provide(c.layer())), 'trunk')
      c.originHead(null)
      assert.strictEqual(yield* repositoryDefault.pipe(Effect.provide(c.layer())), 'main')
    }),
  )

  it.effect('--base names origin/<branch> when the clone has it, else the local branch, else nothing', () =>
    Effect.gen(function* () {
      const c = clone()
      c.ref('refs/heads/sibling', 'HEAD')
      const of = (branch: string) => localRef(branch).pipe(Effect.provide(c.layer()))
      assert.strictEqual(yield* of('candidate/13'), 'origin/candidate/13')
      assert.strictEqual(yield* of('sibling'), 'sibling')
      assert.strictEqual(yield* of('nowhere'), null)
    }),
  )

  it.effect('the remote ref of a branch the clone has not fetched is a BaseError', () =>
    Effect.gen(function* () {
      const c = clone()
      assert.strictEqual(yield* remoteRef('main').pipe(Effect.provide(c.layer())), 'origin/main')
      const error = yield* Effect.flip(remoteRef('candidate/14').pipe(Effect.provide(c.layer())))
      assert.strictEqual(error.message, 'no origin/candidate/14 in this clone: run git fetch origin, or give --base')
    }),
  )
})

describe('the open candidate, from GitHub', () => {
  // GitHub with these open pull requests into the base, recording what it was asked.
  const github = (heads: string[], answers: Partial<GhOperations> = {}) => {
    const asked: string[] = []
    const layer = Gh.memory({
      repository: Effect.sync(() => {
        asked.push('repository')
        return 'org/repo'
      }),
      openPullRequests: (query) =>
        Effect.sync(() => {
          asked.push(`${query.repo} ${query.base} ${query.search}`)
          return heads.map((headRefName, i) => ({ number: i + 1, headRefName }))
        }),
      ...answers,
    })
    return { asked, layer }
  }
  const env = (record: Record<string, string>) => ConfigProvider.layer(ConfigProvider.fromEnvRecord(record))

  it.effect('the lowest open candidate by number, among the heads that are one', () =>
    Effect.gen(function* () {
      const gh = github(['candidate/14', 'candidate/x', 'candidate/13', 'feat/1/y'])
      const open = yield* githubCandidate(CANDIDATE).pipe(Effect.provide(Layer.mergeAll(gh.layer, env({}))))
      assert.strictEqual(open, 'candidate/13')
      assert.deepStrictEqual(gh.asked, ['repository', 'org/repo main head:candidate/'])
    }),
  )

  it.effect('in Actions, the repository is GITHUB_REPOSITORY and gh is not asked for it; none open is null', () =>
    Effect.gen(function* () {
      const gh = github([])
      const open = yield* githubCandidate(CANDIDATE).pipe(
        Effect.provide(Layer.mergeAll(gh.layer, env({ GITHUB_REPOSITORY: 'org/actions' }))),
      )
      assert.strictEqual(open, null)
      assert.deepStrictEqual(gh.asked, ['org/actions main head:candidate/'])
    }),
  )

  it.effect("the project's base: the open candidate GitHub names; with no delivery.candidate GitHub is not asked", () =>
    Effect.gen(function* () {
      const c = clone()
      const gh = github(['candidate/13'])
      const layer = Layer.mergeAll(c.layer(), gh.layer, env({}))
      const base = yield* projectBase(CANDIDATE, 'new').pipe(Effect.provide(layer))
      assert.deepStrictEqual([base.branch, base.ref], ['candidate/13', 'origin/candidate/13'])
      gh.asked.length = 0
      const none = yield* projectBase(null, 'new').pipe(Effect.provide(layer))
      assert.deepStrictEqual([none.branch, none.ref], ['main', 'origin/main'])
      assert.deepStrictEqual(gh.asked, [])
    }),
  )

  it.effect('a gh that fails: the base is origin/main, with the warning that names the failure', () =>
    Effect.gen(function* () {
      const c = clone()
      const gh = github([], { repository: Effect.fail(new GhError({ args: ['repo', 'view'], output: 'no auth' })) })
      const base = yield* projectBase(CANDIDATE, 'head').pipe(
        Effect.provide(Layer.mergeAll(c.layer(), gh.layer, env({}))),
      )
      assert.deepStrictEqual([base.branch, base.ref], ['main', 'origin/main'])
      assert.strictEqual(
        base.warning,
        'the open candidate is unknown (gh repo view failed: no auth): the base is origin/main; give --base if the branch is on a candidate',
      )
    }),
  )
})
