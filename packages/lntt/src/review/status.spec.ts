import { assert, describe, it } from '@effect/vitest'
import * as Digest from 'effect/crypto/Digest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as TestConsole from 'effect/testing/TestConsole'
import { ProjectConfig } from '../config/load.ts'
import { Gh } from '../gh/gh.ts'
import { Git } from '../git/git.ts'
import type { ReviewState } from '../review.ts'
import { ledgerPathIn, statePathIn } from '../review-store.ts'
import { memoryFileSystem } from '../testing/file-system.ts'
import { lockPath } from '../worktree/holder.ts'
import { Pids } from '../worktree/lock.ts'
import { command, type StatusCommand } from './status.ts'

const ROOT = '/r'
const GIT_DIR = `${ROOT}/.git`
const PLACE = `${GIT_DIR}/lntt-review`
const HOME = '/home/me'
const BRANCH = 'feat/1/x'
const SELF = 100
const LIVE = 200

// A branch's state as a round writes it: `findings` its last round's, `extra` anything else.
const stateOf = (findings: ReviewState['result']['findings'] = [], extra: Record<string, unknown> = {}) =>
  ({
    branch: BRANCH,
    round: 1,
    reviewed: 'abc1234',
    rounds: [{ round: 1, head: 'abc1234', tokens: 1500, usd: 0.01, noTokens: [], noUsd: [] }],
    result: {
      base: 'main',
      head: 'abc1234',
      findings,
      refuted: [],
      closed: [],
      failed: [],
      partial: [],
      skipped: [],
      blocking: ['blocker', 'warning'],
      tokens: 1500,
      cost: 0.01,
    },
    ...extra,
  }) as unknown as ReviewState

const BLOCKER = {
  id: 'f1',
  lens: 'code',
  severity: 'blocker',
  path: 'a.ts',
  line: 1,
  what: 'wrong',
  action: 'fix',
  verdict: 'confirmed',
} as unknown as ReviewState['result']['findings'][number]

// The repository in memory: HEAD on `current` ('' detached), the place in the common git
// directory, git answering what it is asked, the lock's processes.
function world(
  options: {
    current?: string
    files?: Record<string, string>
    data?: Record<string, unknown>
    git?: Partial<Git['Service']>
  } = {},
) {
  const current = options.current ?? BRANCH
  const fs = memoryFileSystem({ dirs: [ROOT, GIT_DIR, HOME] })
  for (const [path, text] of Object.entries(options.files ?? {})) Effect.runSync(fs.put(path, text))
  const git = Git.memory({
    commonDir: Effect.succeed(GIT_DIR),
    gitDir: Effect.succeed(GIT_DIR),
    current: Effect.succeed(current),
    branch: Effect.succeed(current || 'HEAD'),
    originUrl: Effect.succeed(''),
    // No origin: whether a branch is merged cannot be told.
    originHead: Effect.succeed(null),
    verify: () => Effect.succeed(null),
    ...options.git,
  })
  const pids = Layer.succeed(Pids)(Pids.of({ self: SELF, visible: (pid) => Effect.succeed(pid === LIVE) }))
  const layer = Layer.mergeAll(
    fs.layer,
    Path.layer,
    Digest.layerWebCrypto,
    git,
    pids,
    Gh.memory({}),
    ProjectConfig.memory(options.data ?? { delivery: { review: { maxRounds: 4 } } }),
  )
  const lntt = (
    parsed: Partial<Extract<StatusCommand, { kind: 'status' }>> | Extract<StatusCommand, { kind: 'cost' }>,
  ) =>
    Effect.gen(function* () {
      const full: StatusCommand =
        'kind' in parsed && parsed.kind === 'cost'
          ? parsed
          : { kind: 'status', json: false, clear: false, prune: false, dryRun: false, ...parsed }
      const ended = yield* command(full, HOME)
      const out = (yield* TestConsole.logLines).join('\n')
      const err = (yield* TestConsole.errorLines).join('\n')
      return { code: 'code' in ended ? ended.code : null, query: 'query' in ended ? ended.query : null, out, err }
    }).pipe(Effect.provide(Layer.mergeAll(layer, Layer.fresh(TestConsole.layer))))
  return { fs, lntt }
}

const state = (branch = BRANCH) => statePathIn(PLACE, branch)
const ledger = (branch = BRANCH) => ledgerPathIn(PLACE, branch)

describe('lntt review status', () => {
  it.effect('a clean round: exit 0, its counts folded and its one line; --json, the whole state', () =>
    Effect.gen(function* () {
      const w = world({ files: { [state()]: JSON.stringify(stateOf()) } })
      const r = yield* w.lntt({})
      assert.strictEqual(r.code, 0, r.err)
      assert.deepStrictEqual(r.out.split('\n').slice(0, 8), [
        'findings: 0 (0 open)',
        'refuted: 0',
        'repeated: 0',
        'closed: 0',
        'failed: 0',
        'partial: 0',
        'skipped: 0',
        'rounds: 1',
      ])
      assert.match(
        r.out,
        /\nlntt review: feat\/1\/x: round 1 of 4, reviewed abc1234, clean; 0 open, 0 replied, 0 closed, 1\.5k tokens, \$0\.01$/,
      )
      const json = yield* world({ files: { [state()]: JSON.stringify(stateOf()) } }).lntt({ json: true })
      const doc = JSON.parse(json.out)
      assert.strictEqual(json.code, 0)
      assert.deepStrictEqual([doc.branch, doc.running, doc.state.current, doc.state.merged], [BRANCH, null, true, null])
      assert.deepStrictEqual([doc.state.round, doc.state.maxRounds, doc.state.limit, doc.state.clean], [1, 4, 4, true])
      assert.match(doc.state.updated, /^\d{4}-\d\d-\d\dT/)
    }),
  )

  it.effect('a confirmed blocker exits 1 with its line; at the limit 3, atLimit; clean at the limit is 0', () =>
    Effect.gen(function* () {
      const open = yield* world({ files: { [state()]: JSON.stringify(stateOf([BLOCKER])) } }).lntt({})
      assert.strictEqual(open.code, 1)
      assert.match(open.out, /, not clean; 1 open \(1 blocking\)/)
      assert.match(open.out, /^ {2}f1 blocker confirmed a\.ts:1 — wrong$/m)
      const one = { delivery: { review: { maxRounds: 1 } } }
      const limit = yield* world({ files: { [state()]: JSON.stringify(stateOf([BLOCKER])) }, data: one }).lntt({
        json: true,
      })
      assert.strictEqual(limit.code, 3)
      assert.deepStrictEqual([JSON.parse(limit.out).state.atLimit, JSON.parse(limit.out).state.limit], [true, 1])
      assert.strictEqual(
        (yield* world({ files: { [state()]: JSON.stringify(stateOf()) }, data: one }).lntt({})).code,
        0,
      )
    }),
  )

  it.effect('no state, another branch’s, or a detached HEAD: exit 4, its one line, state null', () =>
    Effect.gen(function* () {
      const none = yield* world().lntt({})
      assert.deepStrictEqual([none.code, none.out], [4, 'lntt review: no round on feat/1/x yet'])
      const other = yield* world({
        files: { [state('feat/2/y')]: JSON.stringify({ ...stateOf(), branch: 'feat/2/y' }) },
      }).lntt({
        json: true,
      })
      assert.deepStrictEqual([other.code, JSON.parse(other.out)], [4, { branch: BRANCH, running: null, state: null }])
      const detached = yield* world({ current: '' }).lntt({})
      assert.deepStrictEqual([detached.code, detached.out], [4, 'lntt review: no round on detached HEAD yet'])
    }),
  )

  it.effect('a state that cannot be read is an error, exit 1; --clear removes it', () =>
    Effect.gen(function* () {
      for (const text of ['{', 'null', '[]', '{"branch":"feat/1/x","round":1,"reviewed":null}']) {
        const r = yield* world({ files: { [state()]: text } }).lntt({})
        assert.strictEqual(r.code, 1, text)
        assert.strictEqual(
          r.err,
          `lntt review: error: ${state()} cannot be read: pnpm exec lntt review status --clear removes it`,
        )
      }
      const w = world({ files: { [state()]: '{' } })
      const cleared = yield* w.lntt({ clear: true })
      assert.deepStrictEqual([cleared.code, cleared.out], [0, 'lntt review: cleared an unreadable state: its state'])
      assert.isUndefined(w.fs.text(state()))
    }),
  )

  it.effect('a state written before a field existed reads with its default', () =>
    Effect.gen(function* () {
      const old = stateOf([BLOCKER]) as unknown as { result: Record<string, unknown>; rounds?: unknown }
      delete old.result.blocking
      delete old.result.skipped
      delete old.result.closed
      delete old.rounds
      const r = yield* world({ files: { [state()]: JSON.stringify(old) } }).lntt({ json: true })
      const doc = JSON.parse(r.out).state
      assert.deepStrictEqual(
        [doc.blocking, doc.skipped, doc.repeated, doc.rounds],
        [['blocker', 'warning'], [], [], []],
      )
    }),
  )

  it.effect('a lock created an instant ago is no command running yet; --clear waits for it', () =>
    Effect.gen(function* () {
      const w = world({ files: { [lockPath(GIT_DIR)]: '' } })
      assert.strictEqual(JSON.parse((yield* w.lntt({ json: true })).out).running, null)
      const cleared = yield* w.lntt({ clear: true })
      assert.strictEqual(cleared.code, 1)
      assert.strictEqual(
        cleared.err,
        'lntt review: error: a round is running in this worktree (pid starting): nothing cleared',
      )
    }),
  )

  it.effect('a round or a mutation holding the lock is named with its pid; --clear is refused, nothing removed', () =>
    Effect.gen(function* () {
      for (const holder of ['lntt review', 'lntt check tests mutate']) {
        const w = world({ files: { [state()]: JSON.stringify(stateOf()), [lockPath(GIT_DIR)]: `${LIVE} ${holder}` } })
        const r = yield* w.lntt({})
        assert.match(r.out, new RegExp(`${holder} is running \\(pid ${LIVE}\\)`))
        assert.strictEqual(JSON.parse((yield* w.lntt({ json: true })).out).running, LIVE)
        const cleared = yield* w.lntt({ clear: true })
        assert.strictEqual(
          cleared.err,
          `lntt review: error: ${holder} is running in this worktree (pid ${LIVE}): nothing cleared`,
        )
        assert.isString(w.fs.text(state()))
        assert.isString(w.fs.text(lockPath(GIT_DIR)))
      }
    }),
  )

  it.effect('a ledger that cannot be read closes nothing', () =>
    Effect.gen(function* () {
      const r = yield* world({ files: { [state()]: JSON.stringify(stateOf()), [ledger()]: '{' } }).lntt({ json: true })
      assert.deepStrictEqual(JSON.parse(r.out).state.closed, [])
    }),
  )
})

describe('lntt review status --clear', () => {
  const merged = {
    // origin/main exists, and the branch's tip is in it.
    verify: (rev: string) =>
      Effect.succeed(
        rev.startsWith('refs/remotes/origin/main') || rev.startsWith('origin/main')
          ? 'm'
          : rev.startsWith('refs/heads/')
            ? 't'
            : null,
      ),
    isAncestor: () => Effect.succeed(true),
  }

  it.effect('refused while the branch is not merged, or when that cannot be told: the state stays', () =>
    Effect.gen(function* () {
      const unknown = world({ files: { [state()]: JSON.stringify(stateOf()) } })
      const told = yield* unknown.lntt({ clear: true })
      assert.strictEqual(told.code, 1)
      assert.match(
        told.err,
        /whether it is merged cannot be told \(no base to compare with \(no origin\/main in this clone/,
      )
      assert.isString(unknown.fs.text(state()))
      const open = world({
        files: { [state()]: JSON.stringify(stateOf()) },
        git: { ...merged, isAncestor: () => Effect.succeed(false) },
      })
      assert.match(
        (yield* open.lntt({ clear: true })).err,
        /it is not merged \(not in origin\/main\): nothing cleared$/,
      )
      assert.isString(open.fs.text(state()))
    }),
  )

  it.effect('once merged: the state, the ledger and the progress go; the lock never does', () =>
    Effect.gen(function* () {
      const w = world({
        files: {
          [state()]: JSON.stringify(stateOf()),
          [ledger()]: JSON.stringify({ branch: BRANCH, closed: [] }),
          [`${GIT_DIR}/lntt-review.progress`]: '',
        },
        git: merged,
      })
      const r = yield* w.lntt({ clear: true })
      assert.deepStrictEqual([r.code, r.out], [0, "lntt review: cleared feat/1/x's state, ledger and progress"])
      assert.isUndefined(w.fs.text(state()))
      assert.isUndefined(w.fs.text(ledger()))
    }),
  )

  it.effect(
    'an unreadable state of a branch not merged goes alone: its ledger stays; with nothing, nothing to clear',
    () =>
      Effect.gen(function* () {
        const w = world({ files: { [state()]: '{', [ledger()]: JSON.stringify({ branch: BRANCH, closed: [] }) } })
        assert.strictEqual((yield* w.lntt({ clear: true })).out, 'lntt review: cleared an unreadable state: its state')
        assert.isString(w.fs.text(ledger()))
        assert.strictEqual((yield* world().lntt({ clear: true })).out, 'lntt review: nothing to clear')
        assert.strictEqual((yield* world({ current: '' }).lntt({ clear: true })).out, 'lntt review: nothing to clear')
      }),
  )
})

describe('lntt review status --prune', () => {
  const files = {
    [state('feat/1/x')]: '{}',
    [state('feat/2/gone')]: '{}',
    [ledger('feat/2/gone')]: '{}',
    [state('feat/3/merged')]: '{}',
    [state('feat/4/remote')]: '{}',
    [`${PLACE}/state/Fix%2FA.json`]: '{}',
  }
  const git = {
    branchRefs: Effect.succeed(
      ['refs/heads/feat/1/x\t', 'refs/heads/feat/3/merged\t[gone]', 'refs/remotes/origin/feat/4/remote\t'].join('\n'),
    ),
    worktrees: () => Effect.succeed('worktree /r\nHEAD abc\nbranch refs/heads/feat/1/x\n'),
  }

  it.effect('removes what no branch holds any more or whose upstream is gone; --dry-run only says it', () =>
    Effect.gen(function* () {
      const dry = world({ files, git })
      const said = yield* dry.lntt({ prune: true, dryRun: true })
      assert.deepStrictEqual(said.out.split('\n'), [
        'lntt review: would prune feat/2/gone (no branch of that name is left)',
        'lntt review: would prune feat/3/merged (its upstream is gone)',
      ])
      assert.isString(dry.fs.text(state('feat/2/gone')))
      const w = world({ files, git })
      const done = yield* w.lntt({ prune: true })
      assert.deepStrictEqual(done.out.split('\n'), [
        'lntt review: pruned feat/2/gone (no branch of that name is left): state and ledger',
        'lntt review: pruned feat/3/merged (its upstream is gone): state',
      ])
      assert.isUndefined(w.fs.text(state('feat/2/gone')))
      assert.isString(w.fs.text(state('feat/4/remote')))
      assert.isString(w.fs.text(`${PLACE}/state/Fix%2FA.json`))
      assert.strictEqual((yield* world({ git }).lntt({ prune: true })).out, 'lntt review: nothing to prune')
    }),
  )
})

describe('lntt review cost', () => {
  it.effect('the line of the branch’s rounds; --json each round and the total; a query waits for after', () =>
    Effect.gen(function* () {
      const files = { [state()]: JSON.stringify(stateOf()) }
      const line = yield* world({ files }).lntt({ kind: 'cost', json: false })
      assert.deepStrictEqual([line.code, line.out], [0, '1 round, 1.5k tokens, 0.01 USD'])
      const json = JSON.parse((yield* world({ files }).lntt({ kind: 'cost', json: true })).out)
      assert.deepStrictEqual([json.branch, json.total.rounds, json.total.usd], [BRANCH, 1, 0.01])
      const query = yield* world({ files }).lntt({ kind: 'cost', json: false, query: '.total.usd' })
      assert.deepStrictEqual([query.code, query.out, query.query?.command], [null, '', 'lntt review'])
    }),
  )

  it.effect('no state, or a detached HEAD: no rounds; a state that cannot be read is an error', () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* world().lntt({ kind: 'cost', json: false })).out, 'no rounds')
      assert.strictEqual((yield* world({ current: '' }).lntt({ kind: 'cost', json: false })).code, 0)
      const broken = yield* world({ files: { [state()]: '{' } }).lntt({ kind: 'cost', json: false })
      assert.strictEqual(broken.code, 1)
      assert.match(
        broken.err,
        /^lntt review: error: .* cannot be read: pnpm exec lntt review status --clear removes it$/,
      )
    }),
  )
})
