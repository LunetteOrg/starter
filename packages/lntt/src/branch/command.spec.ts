import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { type ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import * as TestConsole from 'effect/testing/TestConsole'
import { Gh, GhError, type Issue } from '../gh/gh.ts'
import { repository } from '../testing/repository.ts'
import type { Host } from '../viewer.ts'
import { type BranchCommand, command, ProjectData, Stdin } from './command.ts'

const ISSUE_77: Issue = {
  title: 'Branch names follow type/issue/slug whatever tool creates the worktree',
  labels: [{ name: 'enhancement' }],
  type: null,
}
const NO_SLUG: Issue = { title: '🚀', labels: [], type: null }

const encode = (text: string) => new TextEncoder().encode(text)

// A clone on main, GitHub's issues, Orca's linked issue, the project's configuration.
function world() {
  const repo = repository()
  repo.commit('c1', null)
  const state = {
    issues: {} as Record<number, Issue>,
    // What `orca worktree current --json` prints; null: orca is not there.
    orca: null as string | null,
    // Its exit code when it is there.
    orcaCode: 0,
    orcaAsked: 0,
    config: {} as Record<string, unknown>,
    // What the loader throws for a configuration that does not validate.
    refused: null as string | null,
  }
  const spawn = (command: ChildProcess.Command) =>
    Effect.gen(function* () {
      if (command._tag !== 'StandardCommand' || command.command !== 'orca') return yield* Effect.die('not orca')
      state.orcaAsked++
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(state.orca === null ? 127 : state.orcaCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(encode(state.orca ?? '')),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    })
  // One run of `lntt branch`: its exit code, stdout and stderr.
  const lntt = (parsed: BranchCommand) =>
    Effect.gen(function* () {
      const code = yield* command(parsed)
      const out = (yield* TestConsole.logLines).join('\n')
      const err = (yield* TestConsole.errorLines).join('\n')
      return { code, out, err }
    }).pipe(
      Effect.provideService(ProjectData, () => {
        if (state.refused !== null) throw new Error(state.refused)
        return state.config
      }),
      Effect.provide(
        Layer.mergeAll(
          repo.layer(),
          Gh.memory({
            issue: (n) =>
              state.issues[n]
                ? Effect.succeed(state.issues[n])
                : Effect.fail(new GhError({ args: ['api', `repos/{owner}/{repo}/issues/${n}`], output: 'HTTP 404' })),
          }),
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.make(spawn)),
          Layer.fresh(TestConsole.layer),
        ),
      ),
    )
  const rename = (host: Host = 'terminal') => lntt({ kind: 'rename', host })
  const inOrca = (issue: number) => {
    state.orca = JSON.stringify({ ok: true, result: { worktree: { linkedIssue: issue } } })
  }
  return Object.assign(state, { repo, lntt, rename, inOrca })
}

describe('lntt branch name', () => {
  it.effect('--type and --slug override what the issue says', () =>
    Effect.gen(function* () {
      const w = world()
      w.issues[77] = ISSUE_77
      const r = yield* w.lntt({ kind: 'name', issue: 77, type: 'chore', slug: 'orca-names' })
      assert.deepStrictEqual([r.code, r.out], [0, 'chore/77/orca-names'])
    }),
  )

  it.effect('a title with nothing to slug is a red result (exit 1), not a usage error', () =>
    Effect.gen(function* () {
      const w = world()
      w.issues[12] = NO_SLUG
      const r = yield* w.lntt({ kind: 'name', issue: 12 })
      assert.strictEqual(r.code, 1)
      assert.match(r.err, /slug/)
      assert.notMatch(r.err, /usage:/)
    }),
  )

  it.effect('an issue gh cannot read is one line and exit 1', () =>
    Effect.gen(function* () {
      const r = yield* world().lntt({ kind: 'name', issue: 404 })
      assert.deepStrictEqual(
        [r.code, r.err],
        [1, 'lntt branch: gh api repos/{owner}/{repo}/issues/404 failed: HTTP 404'],
      )
    }),
  )

  it.effect('without --issue, --type and --slug give the name type/no-issue/slug', () =>
    Effect.gen(function* () {
      const r = yield* world().lntt({ kind: 'name', issue: null, type: 'docs', slug: 'readme-fix' })
      assert.deepStrictEqual([r.code, r.out], [0, 'docs/no-issue/readme-fix'])
    }),
  )

  it.effect('without --issue, a slug that is not 1 to 5 lower-case words is not a valid name', () =>
    Effect.gen(function* () {
      const r = yield* world().lntt({ kind: 'name', issue: null, type: 'docs', slug: 'Not A Slug' })
      assert.strictEqual(r.code, 1)
      assert.match(
        r.err,
        /docs\/no-issue\/Not A Slug is not a valid name: slug Not A Slug is not 1 to \d+ lower-case words/,
      )
    }),
  )

  it.effect("a type the project's delivery.branches.types does not list is not a valid name", () =>
    Effect.gen(function* () {
      const w = world()
      w.config = { delivery: { branches: { types: ['feat'] } } }
      const r = yield* w.lntt({ kind: 'name', issue: null, type: 'docs', slug: 'x' })
      assert.strictEqual(r.code, 1)
      assert.match(r.err, /docs\/no-issue\/x is not a valid name: type docs is not one of feat/)
    }),
  )
})

describe('lntt branch check', () => {
  it.effect('lets tags and branch deletions through', () =>
    Effect.gen(function* () {
      const w = world()
      w.repo.switch('badly-named', 'HEAD')
      const ZERO = '0000000000000000000000000000000000000000'
      const SHA = '1111111111111111111111111111111111111111'
      assert.strictEqual(
        (yield* w.lntt({ kind: 'check', pushed: `refs/tags/v1 ${SHA} refs/tags/v1 ${ZERO}\n` })).code,
        0,
      )
      assert.strictEqual(
        (yield* w.lntt({ kind: 'check', pushed: `(delete) ${ZERO} refs/heads/old-thing ${SHA}\n` })).code,
        0,
      )
    }),
  )

  it.effect('reads the pushed refs from stdin in the pre-push hook', () =>
    Effect.gen(function* () {
      const w = world()
      const ZERO = '0000000000000000000000000000000000000000'
      const SHA = '1111111111111111111111111111111111111111'
      const r = yield* w
        .lntt({ kind: 'check', fromStdin: true })
        .pipe(Effect.provideService(Stdin, () => Promise.resolve(`refs/heads/main ${SHA} refs/heads/wip ${ZERO}\n`)))
      assert.strictEqual(r.code, 1)
      assert.match(r.err, /wip does not follow type\/issue\/slug/)
    }),
  )

  it.effect('a stdin it cannot read is one line with its reason and exit 1, not a crash', () =>
    Effect.gen(function* () {
      const w = world()
      const r = yield* w
        .lntt({ kind: 'check', fromStdin: true })
        .pipe(
          Effect.provideService(Stdin, () =>
            Promise.reject(new Error('EISDIR: illegal operation on a directory, read')),
          ),
        )
      assert.deepStrictEqual(
        [r.code, r.err],
        [1, 'lntt branch: cannot read the pushed refs from stdin: EISDIR: illegal operation on a directory, read'],
      )
    }),
  )

  it.effect('with no name to derive, it says which command prints one', () =>
    Effect.gen(function* () {
      const r = yield* world().lntt({ kind: 'check', branch: 'ilmeskio/probe-b' })
      assert.strictEqual(r.code, 1)
      assert.match(r.err, /; rename it to the name pnpm exec lntt branch name --issue <n> prints$/m)
    }),
  )

  it.effect('lets the base through', () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* world().lntt({ kind: 'check' })).code, 0)
    }),
  )

  it.effect(
    "a detached HEAD at a candidate's head is that candidate; at any other commit, a failure that says so",
    () =>
      Effect.gen(function* () {
        const w = world()
        w.config = { delivery: { candidate: { prefix: 'rc/' } } }
        w.repo.ref('refs/remotes/origin/rc/4', 'HEAD')
        w.repo.detach('HEAD')
        assert.strictEqual((yield* w.lntt({ kind: 'check' })).code, 0)
        w.repo.commit('c2')
        const r = yield* w.lntt({ kind: 'check' })
        assert.deepStrictEqual(
          [r.code, r.err],
          [1, 'lntt branch: HEAD is detached and no origin/rc/<n> points at it: switch to a branch, or give --branch'],
        )
      }),
  )
})

describe('lntt branch check, when git cannot list the refs at a detached HEAD', () => {
  it.effect("ends with git's message and exit 1, not the detached HEAD's", () =>
    Effect.gen(function* () {
      const w = world()
      w.repo.detach('HEAD')
      w.repo.unreadableRefs()
      const r = yield* w.lntt({ kind: 'check' })
      assert.deepStrictEqual([r.code, r.err], [1, 'lntt branch: git for-each-ref failed: fatal: bad object'])
    }),
  )
})

describe('lntt branch rename', () => {
  it.effect('in Orca, builds the name from the linked issue', () =>
    Effect.gen(function* () {
      const w = world()
      w.repo.switch('ilmeskio/probe-a', 'HEAD')
      w.issues[77] = ISSUE_77
      w.inOrca(77)
      const r = yield* w.rename('orca')
      assert.strictEqual(r.code, 0, r.err)
      assert.strictEqual(w.repo.current(), 'feat/77/branch-names-follow-type')
      assert.strictEqual(r.out, 'ilmeskio/probe-a → feat/77/branch-names-follow-type')
    }),
  )

  it.effect('leaves the branch alone when it already follows, or when nothing can be derived', () =>
    Effect.gen(function* () {
      const w = world()
      w.repo.switch('feat/77/branch-names', 'HEAD')
      assert.strictEqual((yield* w.rename()).code, 0)
      assert.strictEqual(w.repo.current(), 'feat/77/branch-names')

      w.repo.switch('ilmeskio/probe-b', 'HEAD')
      const r = yield* w.rename()
      assert.strictEqual(r.code, 0, 'a setup step must not fail on a name it cannot fix')
      assert.match(r.err, /"\$\(pnpm exec lntt branch name --issue <n>\)"/)
      assert.strictEqual(w.repo.current(), 'ilmeskio/probe-b')
      assert.strictEqual(w.orcaAsked, 0, 'Orca is asked only in Orca')
    }),
  )

  it.effect('in Orca, an issue that gives no valid name leaves the branch and the setup alone', () =>
    Effect.gen(function* () {
      const w = world()
      w.repo.switch('ilmeskio/probe-c', 'HEAD')
      w.issues[12] = NO_SLUG
      w.inOrca(12)
      const r = yield* w.rename('orca')
      assert.strictEqual(r.code, 0, r.err)
      assert.match(r.err, /slug/)
      assert.strictEqual(w.repo.current(), 'ilmeskio/probe-c')
    }),
  )

  it.effect('in Orca, an issue gh cannot read, or an Orca that says nothing or fails, leaves the branch alone', () =>
    Effect.gen(function* () {
      const w = world()
      w.repo.switch('ilmeskio/probe-d', 'HEAD')
      w.inOrca(404)
      const unread = yield* w.rename('orca')
      assert.strictEqual(unread.code, 0)
      assert.match(unread.err, /could not read issue #404: gh api .* failed: HTTP 404/)
      const linked = JSON.stringify({ ok: true, result: { worktree: { linkedIssue: 77 } } })
      w.issues[77] = ISSUE_77
      for (const [said, code] of [
        [null, 0],
        ['not json', 0],
        [JSON.stringify({ result: { worktree: {} } }), 0],
        [linked, 1],
      ] as const) {
        w.orca = said
        w.orcaCode = code
        const r = yield* w.rename('orca')
        assert.strictEqual(r.code, 0)
        assert.match(r.err, /holds nothing to rebuild it from/)
      }
      assert.strictEqual(w.repo.current(), 'ilmeskio/probe-d')
    }),
  )

  it.effect('a detached HEAD is reported, not an error', () =>
    Effect.gen(function* () {
      const w = world()
      w.repo.detach('HEAD')
      const r = yield* w.rename()
      assert.strictEqual(r.code, 0, r.err)
      assert.match(r.err, /detached/)
    }),
  )

  it.effect('never overwrites an existing branch', () =>
    Effect.gen(function* () {
      const w = world()
      w.repo.ref('refs/heads/chore/98/orca-yaml', 'HEAD')
      w.repo.switch('ilmeskio/chore-98-orca-yaml', 'HEAD')
      const r = yield* w.rename()
      assert.strictEqual(r.code, 0)
      assert.match(r.err, /already exists/)
      assert.strictEqual(w.repo.current(), 'ilmeskio/chore-98-orca-yaml')
      assert.deepStrictEqual(w.repo.renamed(), [])
    }),
  )

  it.effect('a configuration the loader refuses is one line and exit 1', () =>
    Effect.gen(function* () {
      const w = world()
      w.repo.switch('ilmeskio/chore-98-orca-yaml', 'HEAD')
      w.refused = '.agents/config.jsonc: delivery.branches.types must be an array'
      const r = yield* w.rename()
      assert.deepStrictEqual(
        [r.code, r.err],
        [1, 'lntt branch: .agents/config.jsonc: delivery.branches.types must be an array'],
      )
    }),
  )
})
