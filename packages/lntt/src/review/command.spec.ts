import { assert, describe, it } from '@effect/vitest'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { type ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import * as TestConsole from 'effect/testing/TestConsole'
import { Git, GitError } from '../git/git.ts'
import type { Closed, ReviewState } from '../review.ts'
import { branchKey } from '../review-store.ts'
import { memoryFileSystem } from '../testing/file-system.ts'
import { Pids } from '../worktree/lock.ts'
import { lockPath } from '../worktree-lock.ts'
import { ReviewBridge, ReviewFailed } from './bridge.ts'
import { command, type ReviewCommand } from './command.ts'
import { ReviewStore } from './store.ts'

const ROOT = '/repo'
const GIT_DIR = '/repo/.git'
const STORE = '/repo/.git/lntt-review'
const PROGRESS = `${GIT_DIR}/lntt-review.progress`
const SELF = 4242

// The project's configuration, as review-cli.test.ts's: a code reviewer and a verifier.
const CONFIG = () => ({
  delivery: {
    review: {
      reviewers: {
        decisions: { with: [] },
        tests: { with: [] },
        code: { with: [{ kind: 'claude', model: 'sonnet' }] },
      },
      verify: { with: [{ kind: 'claude', model: 'opus' }] },
    } as Record<string, unknown>,
  },
})

type Tree = Record<string, string>

// A repository in memory: commits on branches, each a whole tree, and the working tree's state.
function repository() {
  const commits = new Map<string, { parent: string | null; tree: Tree; subject: string }>()
  const branches = new Map<string, string>()
  let current: string | null = 'main'
  let detached: string | null = null
  let count = 0
  const repo = {
    dirty: '',
    commit(tree: Tree, subject = 'change') {
      const parent = repo.head()
      const id = `c${++count}`
      commits.set(id, { parent, tree: { ...(parent ? commits.get(parent)?.tree : {}), ...tree }, subject })
      if (current) branches.set(current, id)
      return id
    },
    head: () => (current ? (branches.get(current) ?? null) : detached),
    switch(branch: string, create = false) {
      if (create) branches.set(branch, repo.head() as string)
      current = branch
      detached = null
    },
    detach() {
      detached = repo.head()
      current = null
    },
    ancestors(id: string | null) {
      const seen: string[] = []
      for (let at = id; at; at = commits.get(at)?.parent ?? null) seen.push(at)
      return seen
    },
    tree: (rev: string) =>
      commits.get(rev === 'HEAD' ? (repo.head() as string) : (branches.get(rev) ?? rev))?.tree ?? {},
  }
  const resolve = (rev: string) =>
    rev === 'HEAD' ? repo.head() : (branches.get(rev) ?? (commits.has(rev) ? rev : null))
  const ok = <A>(value: A) => Effect.succeed(value)
  const fail = (args: string[]) => Effect.fail(new GitError({ args, output: 'unknown revision' }))
  const ends = (range: string) => range.split('..') as [string, string]
  const changed = (range: string) => {
    const [from, to] = ends(range)
    const a = repo.tree(from)
    const b = repo.tree(to)
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((path) => a[path] !== b[path]).sort()
  }
  // `git diff -U0` as touchedLines reads it: one hunk per line that differs.
  const written = (range: string) => {
    const [from, to] = ends(range)
    return changed(range)
      .flatMap((path) => {
        const a = (repo.tree(from)[path] ?? '').split('\n')
        const b = (repo.tree(to)[path] ?? '').split('\n')
        const hunks = b.flatMap((line, i) =>
          a[i] === line ? [] : [`@@ -${i + 1},${a[i] === undefined ? 0 : 1} +${i + 1},1 @@`, `+${line}`],
        )
        return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...hunks]
      })
      .join('\n')
  }
  const layer = () =>
    Git.memory({
      status: Effect.sync(() => repo.dirty),
      branch: Effect.sync(() => current ?? 'HEAD'),
      short: (rev) => Effect.suspend(() => (resolve(rev) ? ok(resolve(rev) as string) : fail(['rev-parse', rev]))),
      subject: (rev) => Effect.sync(() => commits.get(resolve(rev) as string)?.subject ?? ''),
      root: ok(ROOT),
      gitDir: ok(GIT_DIR),
      commonDir: ok(GIT_DIR),
      mergeBase: (a, b) =>
        Effect.sync(() => {
          const of = repo.ancestors(resolve(b))
          return repo.ancestors(resolve(a)).find((id) => of.includes(id)) as string
        }),
      isAncestor: (a, b) => Effect.sync(() => repo.ancestors(resolve(b)).includes(a)),
      changed: (range) => Effect.sync(() => changed(range)),
      diff: (range) => Effect.sync(() => written(range)),
      written: (range) => Effect.sync(() => written(range)),
    })
  return Object.assign(repo, { layer })
}

const encode = (text: string) => new TextEncoder().encode(text)

// The agents as review-cli.test.ts's fake claude: the kind of prompt it reads (REVIEW, VERIFY,
// REPLY) picks its answer, by model first; a kind or kind_model in `fails` exits 1 with `boom`.
function agents() {
  const state = {
    answers: {} as Record<string, string>,
    fails: new Set<string>(),
    calls: [] as string[],
    awake: [] as string[][],
    // Runs as an agent answers: what a reviewer does to the working tree.
    during: () => {},
  }
  const spawn = (command: ChildProcess.Command) =>
    Effect.gen(function* () {
      if (command._tag !== 'StandardCommand') return yield* Effect.die('a piped command')
      const args = command.args.map(String)
      if (command.command === 'caffeinate') state.awake.push([...args, `detached=${command.options.detached}`])
      const input = command.options.stdin
      const prompt = Stream.isStream(input)
        ? yield* Stream.mkString(Stream.decodeText(input as Stream.Stream<Uint8Array>))
        : ''
      const kind = prompt.startsWith('You are reviewing')
        ? 'REVIEW'
        : prompt.startsWith('You are checking')
          ? 'VERIFY'
          : 'REPLY'
      const model = args[args.indexOf('--model') + 1]
      const resume = args.indexOf('--resume')
      let stdout = ''
      let code = 0
      if (command.command === 'claude') {
        state.calls.push(`${kind} ${model}${resume >= 0 ? ` --resume ${args[resume + 1]}` : ''}`)
        state.during()
        if (state.fails.has(kind) || state.fails.has(`${kind}_${model}`)) code = 1
        else
          stdout = JSON.stringify({
            result: state.answers[`${kind}_${model}`] ?? state.answers[kind] ?? 'no findings',
            session_id: resume >= 0 ? args[resume + 1] : `sess-${model}-${state.calls.length}`,
            is_error: false,
            total_cost_usd: 0.01,
            usage: { input_tokens: 1000, output_tokens: 500 },
          })
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(state.calls.length + 1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(encode(stdout)),
        stderr: Stream.make(encode(code === 0 ? '' : 'boom\n')),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    })
  const layer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.make(spawn))
  return Object.assign(state, { layer })
}

// A worktree with a branch feat/1/x one commit past main, the project's configuration, and the
// state store under its git directory: each run of `lntt` is a fresh process on the same files.
function world() {
  const fs = memoryFileSystem({ dirs: [GIT_DIR] })
  const repo = repository()
  repo.commit({ 'a.ts': 'export const a = 1' }, 'base')
  repo.switch('feat/1/x', true)
  repo.commit({ 'a.ts': 'export const a = 2' }, 'change')
  const agent = agents()
  const project = {
    config: CONFIG() as Record<string, unknown>,
    // Agents that cannot start, as agentProblems says it.
    problems: [] as string[],
    env: {} as Record<string, string>,
    invalid: null as string | null,
    // A bug of lntt, where the bridge is reached last before the agents.
    defect: false,
  }
  const bridge = Layer.succeed(ReviewBridge)(
    ReviewBridge.of({
      // The configuration as the loader gives it, or the error it throws for a file that does not validate.
      config: Effect.suspend(() =>
        project.invalid === null
          ? Effect.succeed(project.config)
          : Effect.fail(new ReviewFailed({ cause: new Error(project.invalid) })),
      ),
      place: () => Effect.succeed(STORE),
      base: (_root, given) => Effect.succeed({ ref: given ?? 'main', said: given ? null : 'base main' }),
      agentProblems: () => Effect.sync(() => project.problems),
      checks: () => Effect.succeed({}),
      files: () => ({
        readBrief: () => '',
        cite: (path, line) => {
          const text = repo.tree('HEAD')[path]
          if (text === undefined) return { missing: 'no such file', what: 'file' as const }
          const lines = text.split('\n')
          return line === null
            ? { text: null }
            : line <= lines.length
              ? { text: lines[line - 1] as string }
              : { missing: `no line ${line}`, what: 'line' as const }
        },
      }),
      reportsTo: () => Effect.succeed(null),
      askAtLimit: () => Effect.die('no parent'),
      orca: () => (project.defect ? Effect.die(new Error('a bug of lntt')) : Effect.succeed(null)),
    }),
  )
  const pids = Layer.succeed(Pids)(Pids.of({ self: SELF, visible: () => Effect.succeed(false) }))
  // One run of `lntt review`: its exit code, stdout and stderr.
  const lntt = (parsed: ReviewCommand) =>
    Effect.gen(function* () {
      const code = yield* command(parsed)
      const out = (yield* TestConsole.logLines).join('\n')
      const err = (yield* TestConsole.errorLines).join('\n')
      return { code, out, err }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ReviewStore.memory(STORE, GIT_DIR).pipe(Layer.provideMerge(fs.layer)),
          repo.layer(),
          bridge,
          pids,
          agent.layer,
          // Fresh: each run is a process with its own terminal.
          Layer.fresh(TestConsole.layer),
          ConfigProvider.layer(ConfigProvider.fromEnvRecord(project.env)),
        ),
      ),
    )
  const read = <A>(path: string) => JSON.parse(fs.text(path) as string) as A
  return {
    fs,
    repo,
    agent,
    project,
    lntt,
    round: (options: { base?: string; plan?: boolean } = {}) =>
      lntt({ kind: 'round', base: options.base ?? 'main', plan: options.plan ?? false }),
    reply: (id: string, answer: string) => lntt({ kind: 'reply', id, answer }),
    allow: (rounds: number) => lntt({ kind: 'allow', rounds }),
    state: (branch = 'feat/1/x') => read<ReviewState>(`${STORE}/state/${branchKey(branch)}.json`),
    hasState: (branch = 'feat/1/x') => fs.files.has(`${STORE}/state/${branchKey(branch)}.json`),
    ledger: (branch = 'feat/1/x') =>
      read<{ branch: string; closed: Closed[] }>(`${STORE}/ledger/${branchKey(branch)}.json`),
    ledgerText: (branch = 'feat/1/x') => fs.text(`${STORE}/ledger/${branchKey(branch)}.json`),
    putLedger: (text: string, branch = 'feat/1/x') => fs.put(`${STORE}/ledger/${branchKey(branch)}.json`, text),
    putState: (state: unknown, branch = 'feat/1/x') =>
      fs.put(`${STORE}/state/${branchKey(branch)}.json`, JSON.stringify(state)),
    events: () =>
      (fs.text(PROGRESS) ?? '')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown> & { type: string }),
    locked: () => fs.files.has(lockPath(GIT_DIR)),
    withConfig(change: (review: Record<string, unknown>) => void) {
      const config = CONFIG()
      change(config.delivery.review)
      project.config = config
    },
  }
}

const BLOCKER = { REVIEW: '- [blocker] a.ts:1 — wrong — fix', VERIFY: 'confirmed\na.ts:1 shows it' }
const WARNING = { REVIEW: '- [warning] a.ts:1 — w — a', VERIFY: 'confirmed\np' }

describe('lntt review, a round', () => {
  it.effect(
    'a clean round: exit 0, the commit it reviews on its first line, its summary on stdout, the head saved as reviewed',
    () => {
      const w = world()
      return Effect.gen(function* () {
        const r = yield* w.round()
        assert.strictEqual(r.code, 0, r.err)
        assert.match(r.out, /^lntt review: feat\/1\/x: round 1 of 4, reviewed c2, clean; 0 open, 0 replied, 0 closed/)
        assert.strictEqual(
          r.err.split('\n')[0],
          'lntt review: reviewing c2 change (feat/1/x)',
          'the commit it reviews, first',
        )
        assert.match(r.err, /the diff goes to: anthropic \(claude\)/)
        assert.strictEqual(w.state().reviewed, 'c2')
        assert.deepStrictEqual(w.agent.calls, ['REVIEW sonnet'])
        assert.strictEqual(w.locked(), false, 'the lock goes with the round')
      })
    },
  )

  it.effect(
    'refused: a configuration that does not validate, a dirty tree, a detached HEAD; each an error line and event',
    () => {
      const w = world()
      return Effect.gen(function* () {
        w.project.invalid = 'delivery.review.timeoutMinutes must be >= 1'
        const bad = yield* w.round()
        assert.strictEqual(bad.code, 1)
        assert.match(bad.err, /^lntt review: error: [\s\S]*timeoutMinutes must be >= 1/m)
        assert.strictEqual(w.hasState(), false, 'no round on the defaults')
        w.project.invalid = null

        w.repo.dirty = ' M a.ts'
        const dirty = yield* w.round()
        assert.strictEqual(dirty.code, 1)
        assert.match(dirty.err, /^lntt review: error: the working tree has uncommitted changes/m)
        assert.deepStrictEqual(
          w.events().map((e) => e.type),
          ['error'],
          'a round that cannot start leaves an error event for the band, in a file of its own',
        )
        w.repo.dirty = ''

        w.repo.detach()
        assert.match((yield* w.round()).err, /HEAD is detached/)
        assert.strictEqual(w.locked(), false)
      })
    },
  )

  it.effect('--plan prints the plan and what cannot start, takes no lock and starts nothing', () => {
    const w = world()
    return Effect.gen(function* () {
      w.project.problems = ['opencode x/y: opencode is not on the PATH']
      const plan = yield* w.round({ plan: true })
      assert.strictEqual(plan.code, 0, plan.err)
      assert.match(plan.err, /round 1, first round: c1\.\.c2, 1 files\n {2}code: claude sonnet/)
      assert.match(plan.err, /cannot start opencode x\/y: opencode is not on the PATH/)
      assert.deepStrictEqual(w.agent.calls, [])
      assert.strictEqual(w.fs.text(PROGRESS), undefined, 'no progress file')
      const real = yield* w.round()
      assert.strictEqual(real.code, 1, 'a real round refuses')
      assert.match(real.err, /error: cannot start opencode x\/y/)
    })
  })

  it.effect('--plan: an error leaves the progress file of the last round alone', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* w.round()
      const before = w.fs.text(PROGRESS)
      w.project.invalid = 'delivery.review.timeoutMinutes must be >= 1'
      assert.strictEqual((yield* w.round({ plan: true })).code, 1)
      assert.strictEqual(w.fs.text(PROGRESS), before)
    })
  })

  it.effect('the progress goes to stderr with tokens, and to the progress file in order, with its pid', () => {
    const w = world()
    return Effect.gen(function* () {
      Object.assign(w.agent.answers, BLOCKER)
      const r = yield* w.round()
      assert.strictEqual(r.code, 1)
      assert.match(r.err, /lntt review: done code · claude sonnet in \d+s \(1\.5k tokens\)/)
      assert.match(
        r.err,
        /round 1 done in \d+s: 1 findings, 0 refuted, 0 failed, 0 partial, 0 skipped, 0 closed, 3k tokens/,
      )
      const events = w.events()
      assert.deepStrictEqual(
        events.map((e) => [e.type, e.phase ?? e.round ?? '', e.total ?? e.outcome ?? '']),
        [
          ['round', 1, ''],
          ['phase', 'reviewers', 1],
          ['start', 'reviewers', ''],
          ['end', 'reviewers', 'done'],
          ['phase', 'verify', 1],
          ['start', 'verify', ''],
          ['end', 'verify', 'done'],
          ['done', 1, ''],
        ],
      )
      assert.ok(events.every((e) => typeof e.t === 'number'))
      assert.strictEqual(events[0]?.pid, SELF)
      assert.strictEqual(events.at(-1)?.tokens, 3000)
      assert.strictEqual(events[3]?.tokens, 1500)
    })
  })

  it.effect('the progress names the Claude Code session that started the round, or none', () => {
    const w = world()
    return Effect.gen(function* () {
      for (const [id, expected] of [
        ['session-1', 'session-1'],
        [undefined, null],
        ['', null],
      ] as const) {
        w.project.env = id === undefined ? {} : { CLAUDE_CODE_SESSION_ID: id }
        yield* w.round()
        assert.strictEqual(w.events()[0]?.session, expected)
      }
    })
  })

  it.effect('the Mac is kept awake while lntt runs: caffeinate -w its own pid, in a group of its own', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* w.round()
      assert.deepStrictEqual(w.agent.awake, [['-i', '-w', String(SELF), 'detached=true']])
    })
  })

  it.effect('a reviewer that fails: exit 1, listed in failed, and the range is read again next time', () => {
    const w = world()
    return Effect.gen(function* () {
      w.agent.fails.add('REVIEW')
      const r = yield* w.round()
      assert.strictEqual(r.code, 1)
      assert.match(r.err, /^lntt review: failed code · claude sonnet in \d+s: claude exited 1: boom$/m)
      assert.match(w.state().result.failed[0]?.error ?? '', /claude exited 1: boom/)
      assert.strictEqual(w.state().reviewed, null)
      w.agent.fails.clear()
      assert.match((yield* w.round()).err, /round 2, no round read the whole branch/)
    })
  })

  it.effect('a later round that fails keeps the commit the last good round read', () => {
    const w = world()
    return Effect.gen(function* () {
      assert.strictEqual((yield* w.round()).code, 0)
      w.repo.commit({ 'a.ts': 'export const a = 3' })
      w.agent.fails.add('REVIEW')
      assert.strictEqual((yield* w.round()).code, 1)
      assert.strictEqual(w.state().reviewed, 'c2')
    })
  })

  it.effect('a round that fails on another branch than the saved one keeps no reviewed commit', () => {
    const w = world()
    return Effect.gen(function* () {
      assert.strictEqual((yield* w.round()).code, 0)
      w.repo.switch('feat/2/y', true)
      w.repo.commit({ 'a.ts': 'export const a = 9' })
      w.agent.fails.add('REVIEW')
      yield* w.round()
      assert.deepStrictEqual([w.state('feat/2/y').branch, w.state('feat/2/y').reviewed], ['feat/2/y', null])
    })
  })

  it.effect('a branch that changes while the round runs makes the round fail', () => {
    const w = world()
    return Effect.gen(function* () {
      w.agent.during = () => {
        w.repo.dirty = ' M a.ts'
      }
      const r = yield* w.round()
      assert.strictEqual(r.code, 1)
      assert.match(w.state().result.failed.at(-1)?.error ?? '', /the branch moved from c2 during the round/)
    })
  })

  it.effect('an empty delta on a new branch saves round 1, and the branch reviewed before it keeps its round', () => {
    const w = world()
    return Effect.gen(function* () {
      assert.strictEqual((yield* w.round()).code, 0)
      w.repo.commit({ 'a.ts': 'export const a = 5' })
      assert.strictEqual((yield* w.round()).code, 0)
      assert.strictEqual(w.state().round, 2)
      w.repo.switch('main')
      w.repo.switch('feat/3/z', true)
      assert.strictEqual((yield* w.round()).code, 0)
      assert.strictEqual(w.events()[0]?.files, 0, 'the delta was empty')
      const own = w.state('feat/3/z')
      assert.deepStrictEqual([own.branch, own.round, own.rounds], ['feat/3/z', 1, []])
      assert.strictEqual(w.state().round, 2, 'the branch reviewed before keeps its round')
    })
  })

  it.effect("an empty delta on the branch's own state keeps its round and its costs", () => {
    const w = world()
    return Effect.gen(function* () {
      assert.strictEqual((yield* w.round()).code, 0)
      w.repo.commit({ 'a.ts': 'export const a = 5' })
      assert.strictEqual((yield* w.round()).code, 0)
      w.repo.commit({}, 'empty')
      assert.strictEqual((yield* w.round()).code, 0)
      assert.strictEqual(w.events()[0]?.files, 0, 'the delta was empty')
      assert.deepStrictEqual([w.state().round, w.state().rounds?.length], [2, 2])
    })
  })

  it.effect('an optional reviewer that fails is reported as skipped and the round can be clean', () => {
    const w = world()
    return Effect.gen(function* () {
      w.withConfig((review) => {
        review.reviewers = {
          decisions: { with: [] },
          tests: { with: [] },
          code: {
            with: [
              { kind: 'claude', model: 'sonnet' },
              { kind: 'claude', model: 'opus', optional: true },
            ],
          },
        }
        review.verify = false
      })
      w.agent.fails.add('REVIEW_opus')
      const r = yield* w.round()
      assert.strictEqual(r.code, 0, r.err)
      assert.strictEqual(w.state().result.skipped[0]?.agent, 'claude opus')
      assert.strictEqual(w.state().reviewed, 'c2', 'the next round reads only what comes after')
      assert.match(r.err, /lntt review: skipped code · claude opus/)
      assert.notMatch(r.err, /lntt review: failed/)
      assert.deepStrictEqual(
        w
          .events()
          .filter((e) => e.type === 'start')
          .map((e) => [e.label, e.optional]),
        [
          ['code · claude sonnet', false],
          ['code · claude opus', true],
        ],
      )
    })
  })
})

describe('lntt review, a reply', () => {
  it.effect('kept by its reviewer, the finding stays open and reply exits 1', () => {
    const w = world()
    return Effect.gen(function* () {
      Object.assign(w.agent.answers, WARNING)
      yield* w.round()
      w.agent.answers.REPLY = 'kept\nstill wrong'
      const reply = yield* w.reply('f1', 'no')
      assert.strictEqual(reply.code, 1)
      assert.strictEqual(JSON.parse(reply.out).withdrawn, false)
      assert.strictEqual(w.state().result.findings[0]?.verdict, 'confirmed')
      assert.deepStrictEqual(w.state().result.findings[0]?.reply, { answer: 'no', withdrawn: false })
    })
  })

  it.effect('withdrawn by its reviewer, resumed in its session: closed in the ledger, the answer its proof', () => {
    const w = world()
    return Effect.gen(function* () {
      Object.assign(w.agent.answers, BLOCKER)
      yield* w.round()
      assert.deepStrictEqual(w.ledger().closed, [], 'a round with a finding open closes nothing yet')
      const session = w.state().result.findings[0]?.foundBy[0]?.session
      w.agent.answers.REPLY = 'withdrawn\nfair'
      const reply = yield* w.reply('f1', 'line 1 is the point')
      assert.strictEqual(reply.code, 0, reply.err)
      assert.strictEqual(w.agent.calls.at(-1), `REPLY sonnet --resume ${session}`)
      assert.deepStrictEqual(
        w.ledger().closed.map((c) => [c.id, c.outcome, c.proof]),
        [['f1', 'refuted', 'withdrawn by its reviewers after the answer: line 1 is the point']],
      )
      assert.strictEqual(w.locked(), false)
    })
  })

  it.effect('with two reviewers on a finding, it is withdrawn only when both withdraw it', () => {
    const w = world()
    return Effect.gen(function* () {
      w.withConfig((review) => {
        review.reviewers = {
          decisions: { with: [] },
          tests: { with: [] },
          code: {
            with: [
              { kind: 'claude', model: 'sonnet' },
              { kind: 'claude', model: 'opus' },
            ],
          },
        }
        review.verify = false
      })
      w.agent.answers.REVIEW = WARNING.REVIEW
      yield* w.round()
      assert.strictEqual(w.state().result.findings[0]?.foundBy.length, 2)
      Object.assign(w.agent.answers, { REPLY_sonnet: 'withdrawn\nok', REPLY_opus: 'kept\nno' })
      const reply = yield* w.reply('f1', 'it is fine')
      assert.strictEqual(reply.code, 1)
      assert.deepStrictEqual(
        JSON.parse(reply.out).replies.map((x: { withdrawn: boolean }) => x.withdrawn),
        [true, false],
      )
    })
  })

  it.effect(
    'a reply to a finding no reviewer can take up is refused before any agent starts, and frees the lock',
    () => {
      const w = world()
      return Effect.gen(function* () {
        Object.assign(w.agent.answers, WARNING)
        yield* w.round()
        const saved = w.state()
        for (const [foundBy, refusal] of [
          [[{ agent: 'claude', session: null }], /f1: cannot resume claude; the person decides on this finding/],
          [[], /f1: no reviewer to answer/],
        ] as const) {
          ;(saved.result.findings[0] as { foundBy: unknown }).foundBy = foundBy
          yield* w.putState(saved)
          w.agent.calls.length = 0
          const r = yield* w.reply('f1', 'no')
          assert.strictEqual(r.code, 1)
          assert.match(r.err, refusal)
          assert.deepStrictEqual(w.agent.calls, [], 'no agent started')
          assert.strictEqual(w.locked(), false, 'the lock goes with the refusal')
        }
        assert.match((yield* w.reply('f9', 'no')).err, /error: no open finding f9 in the last round/)
      })
    },
  )
})

describe('lntt review, the ledger of the findings the branch closed', () => {
  it.effect('a round that failed, or an empty delta, closes nothing', () => {
    const w = world()
    return Effect.gen(function* () {
      const note = '- [note] (no anchor) — n — a'
      w.agent.answers.REVIEW = `${note}\n- [warning] a.ts:1 — w — a`
      w.agent.fails.add('VERIFY')
      assert.strictEqual((yield* w.round()).code, 1)
      assert.strictEqual(w.ledgerText(), undefined, 'a failed verifier: nothing closed')
      w.agent.fails.clear()
      Object.assign(w.agent.answers, { REVIEW: note, VERIFY: 'refuted\nno' })
      assert.strictEqual((yield* w.round()).code, 0)
      assert.deepStrictEqual(
        w.ledger().closed.map((c) => [c.id, c.severity, c.outcome]),
        [
          ['f1', 'warning', 'fixed'],
          ['f3', 'note', 'accepted'],
        ],
        'the warning the failed round left, and the note of this one',
      )
      const before = w.ledgerText()
      assert.strictEqual((yield* w.round()).code, 0)
      assert.strictEqual(w.ledgerText(), before, 'an empty delta')
    })
  })

  it.effect('a ledger that names another branch is none; one that cannot be read is said and replaced', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* w.putLedger(JSON.stringify({ branch: 'feat/2/y', closed: [{ id: 'f1' }] }))
      Object.assign(w.agent.answers, { REVIEW: WARNING.REVIEW, VERIFY: 'refuted\nno' })
      assert.strictEqual((yield* w.round()).code, 0)
      assert.deepStrictEqual(w.state().result.closed, [])
      assert.strictEqual(w.ledger().branch, 'feat/1/x')
      for (const [i, text] of ['{"branch": "feat/1/x", "clo', '{"branch": "feat/1/x"}'].entries()) {
        yield* w.putLedger(text)
        w.repo.commit({ 'a.ts': `export const a = ${3 + i}` })
        const r = yield* w.round()
        assert.strictEqual(r.code, 0, r.err)
        assert.match(r.err, /ledger\/feat%2F1%2Fx\.json cannot be read: the branch starts a new ledger/)
      }
    })
  })

  it.effect('past delivery.review.warningRounds a confirmed warning does not block, and is accepted open', () => {
    const w = world()
    return Effect.gen(function* () {
      w.withConfig((review) => {
        review.warningRounds = 1
      })
      Object.assign(w.agent.answers, WARNING)
      const first = yield* w.round()
      assert.strictEqual(first.code, 1, 'round 1: a warning blocks')
      assert.notMatch(first.err, /past delivery\.review\.warningRounds/)
      w.repo.commit({ 'a.ts': 'export const a = 3' })
      const second = yield* w.round()
      assert.strictEqual(second.code, 0, second.err)
      assert.deepStrictEqual(w.state().result.blocking, ['blocker'])
      assert.match(second.err, /round 2 is past delivery\.review\.warningRounds \(1\): only blockers block/)
      assert.deepStrictEqual(
        w.ledger().closed.map((c) => [c.id, c.outcome]),
        [['f1', 'accepted']],
      )
      w.repo.commit({ 'a.ts': 'export const a = 4' })
      Object.assign(w.agent.answers, BLOCKER)
      const blockers = yield* w.round()
      assert.strictEqual(blockers.code, 1, 'a blocker blocks past warningRounds too')
      assert.notMatch(blockers.err, /past delivery\.review\.warningRounds/)
    })
  })

  it.effect('a warningRounds not below maxRounds is said in the plan, and at the start of a round', () => {
    const w = world()
    return Effect.gen(function* () {
      w.withConfig((review) => Object.assign(review, { maxRounds: 2, warningRounds: 2 }))
      const warning =
        /^ {2}warning: delivery\.review\.warningRounds \(2\) is not below delivery\.review\.maxRounds \(2\)/m
      assert.match((yield* w.round({ plan: true })).err, warning)
      assert.match((yield* w.round()).err, warning)
    })
  })
})

describe('lntt review at delivery.review.maxRounds, and allow', () => {
  it.effect('the round past it does not start: exit 3, a limit line, what is still open, its event', () => {
    const w = world()
    return Effect.gen(function* () {
      w.withConfig((review) => {
        review.maxRounds = 1
      })
      Object.assign(w.agent.answers, WARNING)
      assert.strictEqual((yield* w.round()).code, 1)
      w.repo.commit({ 'a.ts': 'export const a = 3' })
      const calls = w.agent.calls.length
      const r = yield* w.round()
      assert.strictEqual(r.code, 3, r.err)
      assert.match(
        r.err,
        /^lntt review: limit: round 2 would pass delivery\.review\.maxRounds \(1\) on feat\/1\/x; still open: f1 \(warning, confirmed\)$/m,
      )
      assert.match(r.out, /^ {2}f1 warning confirmed a\.ts:1 — w$/m)
      assert.match(r.out, /^lntt review: feat\/1\/x: round 1 of 1, .*, round 2 refused at the limit; /)
      assert.strictEqual(w.agent.calls.length, calls, 'no agent started')
      assert.deepStrictEqual(w.events().at(-1), {
        ...w.events().at(-1),
        type: 'limit',
        round: 2,
        maxRounds: 1,
        allowed: 0,
        open: 1,
        failed: 0,
      })
      assert.strictEqual(w.events().at(-1)?.asked, undefined, 'a branch with no parent sends nothing')
    })
  })

  it.effect('a person allows more rounds for the branch, and the next round runs; refused before any round', () => {
    const w = world()
    return Effect.gen(function* () {
      w.withConfig((review) => {
        review.maxRounds = 1
      })
      const refused = yield* w.allow(1)
      assert.strictEqual(refused.code, 1)
      assert.match(refused.err, /no round on feat\/1\/x yet/)
      assert.strictEqual(w.fs.text(PROGRESS), undefined, 'a refused allow starts no progress')
      assert.strictEqual(w.locked(), false, 'the lock goes with the refusal')

      assert.strictEqual((yield* w.round()).code, 0)
      w.repo.commit({ 'a.ts': 'export const a = 3' })
      assert.strictEqual((yield* w.round()).code, 3)
      const allow = yield* w.allow(2)
      assert.strictEqual(allow.code, 0, allow.err)
      assert.match(allow.err, /feat\/1\/x may take 3 rounds: delivery\.review\.maxRounds \(1\) and 2 allowed/)
      assert.deepStrictEqual(
        w.events().map((e) => [e.type, e.allowed]),
        [['allow', 2]],
        'the band no longer shows the limit',
      )
      const r = yield* w.round()
      assert.strictEqual(r.code, 0, r.err)
      assert.strictEqual(w.state().allowed, 2, 'kept by the round')
      assert.strictEqual((yield* w.allow(1)).code, 0)
      assert.strictEqual(w.state().allowed, 3, 'added to what was allowed')
    })
  })

  it.effect('the rounds allowed count in the limit, and stay with their branch', () => {
    const w = world()
    return Effect.gen(function* () {
      w.withConfig((review) => {
        review.maxRounds = 1
      })
      yield* w.round()
      yield* w.allow(1)
      w.repo.commit({ 'a.ts': 'export const a = 3' })
      assert.strictEqual((yield* w.round()).code, 0)
      w.repo.commit({ 'a.ts': 'export const a = 4' })
      const r = yield* w.round()
      assert.strictEqual(r.code, 3, r.err)
      assert.match(r.err, /delivery\.review\.maxRounds \(1\) and 1 allowed on feat\/1\/x/)
      w.repo.switch('feat/2/y', true)
      w.repo.commit({ 'a.ts': 'export const a = 5' })
      assert.match((yield* w.allow(1)).err, /no round on feat\/2\/y yet/)
      assert.strictEqual((yield* w.round()).code, 0)
      assert.strictEqual(w.state('feat/2/y').allowed, undefined, 'a new branch starts with nothing allowed')
      assert.strictEqual(w.state().allowed, 1)
    })
  })

  it.effect('--plan names the limit; a run with no new commit is not a round and is not stopped', () => {
    const w = world()
    return Effect.gen(function* () {
      w.withConfig((review) => {
        review.maxRounds = 1
      })
      assert.strictEqual((yield* w.round()).code, 0)
      assert.strictEqual((yield* w.round()).code, 0, 'nothing new to read')
      w.repo.commit({ 'a.ts': 'export const a = 3' })
      const plan = yield* w.round({ plan: true })
      assert.strictEqual(plan.code, 0, plan.err)
      assert.match(plan.err, /limit: round 2 would pass delivery\.review\.maxRounds \(1\): it will not start/)
    })
  })
})

describe('lntt review, its lock and its errors', () => {
  it.effect('a round is refused while another command holds the lock, which it leaves with its progress', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* w.round()
      const progress = w.fs.text(PROGRESS)
      yield* w.fs.put(lockPath(GIT_DIR), '999 lntt check tests mutate')
      // The holder is alive: Pids sees only SELF, so a fresh lock gives it the doubt.
      const r = yield* w.round()
      assert.strictEqual(r.code, 1)
      assert.match(
        r.err,
        /^lntt review: error: lntt check tests mutate is already running in this worktree \(pid 999\)$/m,
      )
      assert.strictEqual(w.fs.text(lockPath(GIT_DIR)), '999 lntt check tests mutate')
      assert.strictEqual(w.fs.text(PROGRESS), `${progress}`, "the holder's progress file is left alone")
    })
  })

  it.effect('a state file that names another branch is an error, reported with its event', () => {
    const w = world()
    return Effect.gen(function* () {
      yield* w.putState({ branch: 'feat/2/y', round: 1 })
      const r = yield* w.round()
      assert.strictEqual(r.code, 1)
      assert.match(
        r.err,
        /^lntt review: error: .*state\/feat%2F1%2Fx\.json cannot be read: pnpm exec lntt review status --clear removes it$/m,
      )
      assert.deepStrictEqual(
        w.events().map((e) => [e.type, e.message]),
        [['error', `${STORE}/state/feat%2F1%2Fx.json cannot be read: pnpm exec lntt review status --clear removes it`]],
      )
    })
  })

  it.effect('a defect writes its error line and event, frees the lock, and reaches the runner', () => {
    const w = world()
    return Effect.gen(function* () {
      w.project.defect = true
      const ending = yield* Effect.exit(w.round())
      assert.ok(ending._tag === 'Failure', 'the defect reaches the runner')
      assert.strictEqual(w.events().at(-1)?.type, 'error')
      assert.strictEqual(w.locked(), false)
    })
  })
})
