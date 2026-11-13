import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as TestConsole from 'effect/testing/TestConsole'
import { Gh, GhError } from '../gh/gh.ts'
import { Git, GitError } from '../git/git.ts'
import { RETRO_START } from '../pull-request.ts'
import { filesAt } from '../testing/fixtures.ts'
import { lockPath } from '../worktree/holder.ts'
import { Pids } from '../worktree/lock.ts'
import { SyncAreas, type SyncChecks } from './areas.ts'
import { type CheckCommand, Checks, ChecksLive, command, queryOf } from './command.ts'
import { TestRunner } from './mutate.ts'
import type { Result } from './results.ts'

const ROOT = '/repo'
const GIT_DIR = `${ROOT}/.git`
const SELF = 100
const LIVE = 200

const CONFIG = JSON.stringify({
  recording: { logs: { adr: { path: 'docs/adr', index: 'docs/adr/README.md' } } },
  delivery: { candidate: { prefix: 'candidate/' } },
})
const PROJECT = {
  '.agents/config.jsonc': CONFIG,
  'docs/adr/README.md': '# Decisions\n\n| [storage](./storage.md) |\n',
  'docs/adr/storage.md': '# Storage\n\nData lives in Postgres.\n',
  'src/app.ts': '// Where data lives: docs/adr/storage.md\nexport const answer = 42\n',
}

// What lntt sync's areas say, all in step.
const IN_STEP: SyncChecks = {
  agentsBlock: () => true,
  skills: () => [],
  stubFolders: () => [],
  settings: () => [],
  workflows: () => [
    { area: 'workflows', check: 'automated', status: 'PASS', path: null, line: null, message: 'in step' },
  ],
}

// The project in memory, git and GitHub as they answer, lntt sync's areas, and the processes.
function world(
  options: {
    texts?: Record<string, string>
    git?: Partial<Git['Service']>
    gh?: Partial<Gh['Service']>
    sync?: Partial<SyncChecks>
  } = {},
) {
  const texts = options.texts ?? PROJECT
  const fs = filesAt(ROOT, texts)
  fs.files.delete(`${ROOT}/.git`)
  const git = Git.memory({
    listFiles: (_dir, list = {}) => Effect.succeed(list.others ? [] : Object.keys(texts)),
    gitDirOf: () => Effect.succeed(GIT_DIR),
    ...options.git,
  })
  const pids = Layer.succeed(Pids)(
    Pids.of({ self: SELF, visible: (pid) => Effect.succeed(pid === LIVE || pid === SELF) }),
  )
  const runner = Layer.succeed(TestRunner)(TestRunner.of({ run: () => Effect.die('no test runs here') }))
  const layer = Layer.mergeAll(fs.layer, Path.layer, git, Gh.memory(options.gh ?? {}), pids, runner)
  // One run of `lntt check`: its exit code (null with a query), its results, stdout and stderr.
  const lntt = (parsed: Record<string, unknown> & { kind: CheckCommand['kind'] }) =>
    Effect.gen(function* () {
      const { found, code } = yield* command({ cwd: ROOT, json: false, ...parsed } as unknown as CheckCommand)
      const out = (yield* TestConsole.logLines).join('\n')
      const err = (yield* TestConsole.errorLines).join('\n')
      return { code, found, out, err }
    }).pipe(
      Effect.provide(Layer.mergeAll(layer, TestConsole.layer)),
      Effect.provideService(SyncAreas, { ...IN_STEP, ...options.sync }),
    )
  return { fs, lntt }
}

const statuses = (found: Result[]) => found.map((r) => `${r.status} ${r.area}/${r.check}`)

describe('lntt check', () => {
  it.effect('alone runs every area and prints each result, then the counts; a FAIL exits 1', () =>
    Effect.gen(function* () {
      const passing = yield* world().lntt({ kind: 'all' })
      assert.strictEqual(passing.code, 0)
      assert.deepStrictEqual(
        [...new Set(passing.found.map((r) => r.area))],
        ['agents-md', 'skills', 'plugin', 'workflows', 'decisions', 'tests', 'body'],
      )
      assert.match(passing.out, /^lntt check: \d+ PASS, 0 FAIL, \d+ NOT RUN$/m)
      const failing = yield* world({ sync: { agentsBlock: () => false } }).lntt({ kind: 'all', json: true })
      assert.strictEqual(failing.code, 1)
      const printed = failing.out.split('\n').filter((l) => l.startsWith('{'))
      assert.strictEqual(printed.length, failing.found.length)
      assert.deepStrictEqual(JSON.parse(printed[0] as string), {
        area: 'agents-md',
        check: 'block',
        status: 'FAIL',
        path: 'AGENTS.md',
        line: null,
        message:
          'the managed block is missing or edited; run pnpm exec lntt sync (edit agents/block.md of @lntt/lntt, not the block)',
      })
    }),
  )

  it.effect('with a query, nothing is printed and the code waits for the query, built from the results', () =>
    Effect.gen(function* () {
      const parsed: CheckCommand = {
        cwd: ROOT,
        kind: 'area',
        area: 'decisions',
        files: [],
        query: '.status',
        json: false,
      }
      const run = yield* world().lntt(parsed)
      assert.strictEqual(run.code, null)
      assert.strictEqual(run.out, '')
      const query = queryOf(parsed, run.found)
      assert.strictEqual(query.code, 0)
      assert.strictEqual(query.input.split('\n').filter(Boolean).length, run.found.length)
      assert.strictEqual(query.command, 'lntt check')
    }),
  )

  it.effect('the files every area reads leave out the stubs of the shared skills and a nested project', () =>
    Effect.gen(function* () {
      const texts = {
        ...PROJECT,
        '.claude/skills/review/SKILL.md': 'Cites docs/adr/gone.md.\n',
        'templates/web/.agents/config.jsonc': '{}',
        'templates/web/README.md': 'Its own docs/adr/storage-two.md.\n',
      }
      const run = yield* world({ texts, sync: { stubFolders: () => ['.claude/skills/review'] } }).lntt({
        kind: 'area',
        area: 'decisions',
        files: [],
      })
      assert.strictEqual(run.code, 0, run.out)
    }),
  )
})

describe('what lntt check cannot do', () => {
  it.effect('no configuration is a configuration error, in one line', () =>
    Effect.gen(function* () {
      const { '.agents/config.jsonc': _, ...texts } = PROJECT
      const run = yield* world({ texts }).lntt({ kind: 'all' })
      assert.strictEqual(run.code, 1)
      assert.strictEqual(run.err, 'lntt: no .agents/config.jsonc or .agents/config.yml in /repo or above')
    }),
  )

  it.effect('a configuration that does not validate is one line', () =>
    Effect.gen(function* () {
      const run = yield* world({ texts: { ...PROJECT, '.agents/config.jsonc': '{ "tests": 3 }' } }).lntt({
        kind: 'all',
      })
      assert.strictEqual(run.code, 1)
      assert.match(run.err, /^lntt: \/repo\/\.agents\/config\.jsonc /)
    }),
  )

  it.effect('git that cannot list the files: the check cannot run, one line', () =>
    Effect.gen(function* () {
      const run = yield* world({
        git: { listFiles: () => Effect.fail(new GitError({ args: ['ls-files'], output: 'not a git repository' })) },
      }).lntt({ kind: 'area', area: 'decisions', files: [] })
      assert.strictEqual(run.code, 1)
      assert.strictEqual(run.err, 'lntt: error: git cannot list the files of /repo: lntt check reads a git repository')
    }),
  )

  it.effect("what the sync code of lntt sync's areas throws is one line", () =>
    Effect.gen(function* () {
      const run = yield* world({
        sync: {
          skills: () => {
            throw new Error('.agents/skills cannot be read')
          },
        },
      }).lntt({ kind: 'area', area: 'skills', files: [] })
      assert.strictEqual(run.code, 1)
      assert.strictEqual(run.err, 'lntt: error: .agents/skills cannot be read')
    }),
  )

  it.effect('a mutation outside a git repository cannot run, and says so', () =>
    Effect.gen(function* () {
      const run = yield* world({
        git: { gitDirOf: () => Effect.fail(new GitError({ args: ['rev-parse'], output: 'no' })) },
      }).lntt({ kind: 'mutate', anchor: 'src/app.ts:2', text: '42', to: '43', tests: ['test/app.test.ts'] })
      assert.strictEqual(run.code, 1)
      assert.strictEqual(run.err, 'lntt: error: /repo has no git directory: a mutation needs one')
    }),
  )

  it.effect('a mutation is refused while a round of lntt review holds the lock, which it keeps', () =>
    Effect.gen(function* () {
      const w = world({ texts: { ...PROJECT, '.git/HEAD': 'ref: refs/heads/main\n' } })
      w.fs.files.set(lockPath(GIT_DIR), { text: `${LIVE} lntt review`, mtime: Date.now() })
      const run = yield* w.lntt({ kind: 'mutate', anchor: 'src/app.ts:2', text: '42', to: '43', tests: ['t.test.ts'] })
      assert.strictEqual(run.code, 1)
      assert.strictEqual(run.err, `lntt: error: lntt review is already running in this worktree (pid ${LIVE})`)
      assert.strictEqual(w.fs.files.get(lockPath(GIT_DIR))?.text, `${LIVE} lntt review`)
    }),
  )
})

describe('lntt check cite', () => {
  it.effect('prints what is on each line; a line or a file that is not there fails', () =>
    Effect.gen(function* () {
      const run = yield* world().lntt({
        kind: 'cite',
        anchors: ['src/app.ts:2', 'src/app.ts:2-3', 'src/app.ts:9', 'src/nope.ts:1', '../outside.ts:1', 'docs/adr:1'],
      })
      assert.strictEqual(run.code, 1)
      assert.deepStrictEqual(
        run.found.map((x) => `${x.status} ${x.path}:${x.line} ${x.message}`),
        [
          'PASS src/app.ts:2 export const answer = 42',
          'PASS src/app.ts:2 export const answer = 42',
          'FAIL src/app.ts:9 no line 9: the file has 2 lines',
          'FAIL src/nope.ts:1 no such file',
          'FAIL ../outside.ts:1 no such file',
          'FAIL docs/adr:1 no such file',
        ],
      )
    }),
  )
})

describe('lntt check body', () => {
  const RULES = { delivery: { candidate: { prefix: 'candidate/' } } }
  const BLOCK = `${RETRO_START}\n- **Friction:** none\n<!-- retro:end -->\n`
  const body = (
    texts: Record<string, string>,
    gh: Partial<Gh['Service']>,
    given: { stdin: string } | { pr?: number },
  ) =>
    world({ texts: { ...texts, '.agents/config.jsonc': JSON.stringify(RULES) }, gh }).lntt({
      kind: 'area',
      area: 'body',
      check: given && 'stdin' in given ? '-' : undefined,
      files: [],
      body: given,
    })
  const retro = (found: Result[]) =>
    found.filter((x) => x.check === 'retrospective').map((x) => `${x.status} ${x.message}`)

  it.effect('reads the body given on stdin, of the pull request named, or of the current branch', () =>
    Effect.gen(function* () {
      const asked: (number | undefined)[] = []
      const gh = {
        pullRequest: (number?: number) =>
          Effect.sync(() => {
            asked.push(number)
            return { number: number ?? 7, body: BLOCK, headRefName: 'feat/7/x' }
          }),
      }
      assert.match(retro((yield* body(PROJECT, gh, { stdin: BLOCK })).found)[0] as string, /^\S+ stdin: /)
      assert.match(retro((yield* body(PROJECT, gh, { pr: 12 })).found)[0] as string, /pull request #12: /)
      assert.match(retro((yield* body(PROJECT, gh, {})).found)[0] as string, /the current branch's pull request: /)
      assert.deepStrictEqual(asked, [12, undefined])
    }),
  )

  it.effect("a candidate's block is read from its retrospective comment, not its body", () =>
    Effect.gen(function* () {
      const gh = {
        pullRequest: () => Effect.succeed({ number: 15, body: 'rebuilt at every squash', headRefName: 'candidate/15' }),
        issueComments: ({ number }: { repo: string; number: number }) =>
          Effect.succeed(
            number === 15
              ? [
                  { id: 1, body: 'hello' },
                  { id: 2, body: BLOCK },
                ]
              : [],
          ),
      }
      assert.match(
        retro((yield* body(PROJECT, gh, { pr: 15 })).found)[0] as string,
        /the retrospective comment of candidate #15/,
      )
      const none = { ...gh, issueComments: () => Effect.succeed([]) }
      assert.match(
        retro((yield* body(PROJECT, none, { pr: 15 })).found)[0] as string,
        /^FAIL the comments of candidate #15/,
      )
    }),
  )

  it.effect('a pull request gh cannot read: the check cannot run, one line', () =>
    Effect.gen(function* () {
      const gh = {
        pullRequest: () =>
          Effect.fail(new GhError({ args: ['pr', 'view'], output: 'no pull requests found for branch "main"\nmore' })),
      }
      const run = yield* body(PROJECT, gh, {})
      assert.strictEqual(run.code, 1)
      assert.strictEqual(run.err, 'lntt: error: gh pr view failed: no pull requests found for branch "main"')
    }),
  )

  it.effect('the template must hold the block lntt pr block prints; none is NOT RUN', () =>
    Effect.gen(function* () {
      const template = (texts: Record<string, string>) =>
        Effect.map(
          world({ texts: { ...texts, '.agents/config.jsonc': '{}' } }).lntt({
            kind: 'area',
            area: 'body',
            check: 'template',
            files: [],
          }),
          (run) => run.found.map((x) => `${x.status} ${x.message}`),
        )
      assert.deepStrictEqual(yield* template(PROJECT), ['NOT RUN no pull request template'])
      assert.deepStrictEqual(yield* template({ ...PROJECT, '.github/pull_request_template.md': '## Why\n' }), [
        'FAIL no retrospective block: paste what pnpm exec lntt pr block prints',
      ])
    }),
  )
})

describe('the areas lntt review reads', () => {
  it.effect('each lens named after an area gets its results as JSON, touched from the imports', () =>
    Effect.gen(function* () {
      const fs = filesAt(ROOT, PROJECT)
      const git = Git.memory({
        listFiles: (_dir, list = {}) => Effect.succeed(list.others ? [] : Object.keys(PROJECT)),
        nameStatus: () => Effect.succeed(''),
        addedFrom: () => Effect.succeed(''),
      })
      const runner = Layer.succeed(TestRunner)(TestRunner.of({ run: () => Effect.die('a round runs no test') }))
      const checks = yield* Effect.gen(function* () {
        const checked = yield* Checks
        return yield* checked.lenses(['decisions', 'tests'], { root: ROOT, data: JSON.parse(CONFIG), base: 'main' })
      }).pipe(
        Effect.provide(ChecksLive.pipe(Layer.provide(Layer.mergeAll(fs.layer, Path.layer, git, runner)))),
        Effect.provideService(SyncAreas, IN_STEP),
      )
      assert.deepStrictEqual(Object.keys(checks), ['decisions', 'tests'])
      const decisions = (checks.decisions as string)
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Result)
      assert.deepStrictEqual(statuses(decisions).slice(0, 2), ['PASS decisions/index', 'PASS decisions/references'])
      assert.match(checks.tests as string, /the configuration has no tests section/)
    }),
  )
})
