import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as TestConsole from 'effect/testing/TestConsole'
import { Git } from '../git/git.ts'
import { memoryFileSystem } from '../testing/file-system.ts'
import { memorySpawner, pathAsk, type Said } from '../testing/spawner.ts'
import { command, type LocalCommand, queryOf } from './command.ts'

const MAIN = '/repo'
const LINKED = '/work/a'
const HOME = '/home/me'
const WEB = { port: 5173, url: 'http://localhost:{port}', commands: { start: { run: 'pnpm dev --port {port}' } } }

// The project at MAIN and its linked worktree at LINKED, the operator's home, git as it answers in
// `at`, and the processes: the commands on `path`, the others answered by `answer`.
function world(
  options: {
    at?: string
    apps?: Record<string, unknown>
    files?: Record<string, string>
    path?: string[]
    answer?: (command: string, args: string[]) => Said
  } = {},
) {
  const at = options.at ?? MAIN
  const fs = memoryFileSystem({ dirs: [MAIN, LINKED, HOME, `${MAIN}/.git`] })
  const linked = at === LINKED
  const git = Git.memory({
    root: Effect.succeed(at),
    gitDir: Effect.succeed(linked ? `${MAIN}/.git/worktrees/a` : `${MAIN}/.git`),
    commonDir: Effect.succeed(`${MAIN}/.git`),
    worktrees: () =>
      Effect.succeed(`worktree ${MAIN}\nHEAD abc\nbranch refs/heads/main\n\nworktree ${LINKED}\nHEAD abc\ndetached\n`),
    originUrl: Effect.succeed(''),
  })
  const spawner = memorySpawner(
    (command, args) => pathAsk(command, args, options.path ?? []) ?? options.answer?.(command, args) ?? 'missing',
  )
  const lntt = (parsed: Record<string, unknown> & { kind: LocalCommand['kind'] }) =>
    Effect.gen(function* () {
      yield* fs.put(`${at}/.agents/config.jsonc`, JSON.stringify({ local: { apps: options.apps ?? { web: WEB } } }))
      for (const [path, text] of Object.entries(options.files ?? {})) yield* fs.put(path, text)
      const ended = yield* command({
        cwd: at,
        home: HOME,
        env: {},
        platform: 'darwin',
        json: false,
        tmp: '/tmp',
        ...parsed,
      } as LocalCommand)
      const out = (yield* TestConsole.logLines).join('\n')
      const err = (yield* TestConsole.errorLines).join('\n')
      return { ...ended, out, err }
    }).pipe(Effect.provide(Layer.mergeAll(fs.layer, Path.layer, git, spawner.layer, Layer.fresh(TestConsole.layer))))
  // The commands run, but the PATH lookups.
  const ran = () => spawner.asked.filter((a) => a.command !== 'sh')
  return { fs, lntt, ran }
}

describe('lntt local app', () => {
  it.effect('in the main checkout: the app on its base port, as JSON', () =>
    Effect.gen(function* () {
      const run = yield* world().lntt({ kind: 'app', name: 'web' })
      assert.strictEqual(run.code, 0)
      assert.deepStrictEqual(JSON.parse(run.out), {
        name: 'web',
        port: 5173,
        url: 'http://localhost:5173',
        readyPath: '/',
        commands: { start: { run: 'pnpm dev --port 5173' } },
      })
    }),
  )

  it.effect('in a linked worktree: the slot the common directory keeps for it, stable across calls', () =>
    Effect.gen(function* () {
      const w = world({ at: LINKED, files: { [`${MAIN}/.git/lunette/ports.json`]: '{"/work/gone": 1}' } })
      const first = yield* w.lntt({ kind: 'app', name: 'web' })
      assert.strictEqual(JSON.parse(first.out).port, 5183, 'the slot of a worktree gone is free')
      assert.deepStrictEqual(JSON.parse(w.fs.text(`${MAIN}/.git/lunette/ports.json`) as string), { [LINKED]: 1 })
      const again = yield* w.lntt({ kind: 'app', name: 'web' })
      assert.strictEqual(JSON.parse(again.out).port, 5183)
    }),
  )

  it.effect('an unknown app, or a slots file that is not a JSON object of slots, exits 1 in one line', () =>
    Effect.gen(function* () {
      const unknown = yield* world().lntt({ kind: 'app', name: 'admin' })
      assert.deepStrictEqual([unknown.code, unknown.err], [1, 'lntt: no app admin in local.apps (web)'])
      for (const text of ['nope', 'null', '[1]', '{"/work/a": "one"}']) {
        const broken = yield* world({ at: LINKED, files: { [`${MAIN}/.git/lunette/ports.json`]: text } }).lntt({
          kind: 'app',
          name: 'web',
        })
        assert.strictEqual(broken.code, 1, text)
        assert.strictEqual(
          broken.err,
          `lntt: ${MAIN}/.git/lunette/ports.json is not a JSON object of slots: remove it, and the slots start again`,
        )
      }
    }),
  )
})

describe('lntt viewer', () => {
  it.effect('detect prints the host, the viewer and why', () =>
    Effect.gen(function* () {
      const run = yield* world({ path: ['orca'] }).lntt({ kind: 'viewer', env: { TERM_PROGRAM: 'Orca' } })
      assert.strictEqual(run.code, 0)
      const choice = JSON.parse(run.out)
      assert.deepStrictEqual([choice.host, choice.viewer], ['orca', 'orca'])
      assert.isString(choice.reason)
    }),
  )

  it.effect('open in Orca: goto in the browser of this worktree; a tab on the page when it has none', () =>
    Effect.gen(function* () {
      const url = 'http://localhost:5183/'
      const ok = world({ path: ['orca'], answer: () => ({}) })
      assert.strictEqual((yield* ok.lntt({ kind: 'viewer', env: { TERM_PROGRAM: 'Orca' }, open: url })).code, 0)
      assert.deepStrictEqual(ok.ran(), [
        { command: 'orca', args: ['goto', '--url', url, '--worktree', `path:${MAIN}`, '--json'], detached: false },
      ])
      const noTab = world({
        path: ['orca'],
        answer: (_, args) =>
          args[0] === 'goto' ? { out: '{"ok":false,"error":{"code":"browser_no_tab"}}', code: 1 } : {},
      })
      assert.strictEqual((yield* noTab.lntt({ kind: 'viewer', env: { TERM_PROGRAM: 'Orca' }, open: url })).code, 0)
      assert.deepStrictEqual(
        noTab.ran().map((a) => a.args.slice(0, 2).join(' ')),
        ['goto --url', 'tab create'],
      )
    }),
  )

  it.effect('open in Orca: another goto failure exits 1 with what orca said, and opens no tab', () =>
    Effect.gen(function* () {
      const w = world({
        path: ['orca'],
        answer: () => ({ out: '{"ok":false,"error":{"code":"runtime_unavailable"}}', code: 1 }),
      })
      const run = yield* w.lntt({ kind: 'viewer', env: { TERM_PROGRAM: 'Orca' }, open: 'u' })
      assert.strictEqual(run.code, 1)
      assert.strictEqual(run.err, 'lntt: orca goto failed: {"ok":false,"error":{"code":"runtime_unavailable"}}')
      assert.strictEqual(w.ran().length, 1)
    }),
  )

  it.effect('open with the preferred Playwright CLI starts it detached; Wave runs wsh', () =>
    Effect.gen(function* () {
      const files = { [`${HOME}/.agents/operator.jsonc`]: '{"workspace":{"viewers":["playwright"]}}' }
      const playwright = world({ path: ['playwright'], files, answer: () => ({}) })
      assert.strictEqual((yield* playwright.lntt({ kind: 'viewer', open: 'u' })).code, 0)
      assert.deepStrictEqual(playwright.ran(), [
        { command: 'playwright', args: ['open', 'u'], detached: true, released: true },
      ])
      const wave = world({ path: ['wsh'], answer: () => ({}) })
      assert.strictEqual((yield* wave.lntt({ kind: 'viewer', env: { TERM_PROGRAM: 'waveterm' }, open: 'u' })).code, 0)
      assert.deepStrictEqual(wave.ran(), [{ command: 'wsh', args: ['web', 'open', 'u'], detached: false }])
    }),
  )

  it.effect('open for an agent action prints the call and the page, exit 3, and runs nothing', () =>
    Effect.gen(function* () {
      const w = world()
      const run = yield* w.lntt({ kind: 'viewer', env: { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }, open: 'u' })
      assert.strictEqual(run.code, 3)
      assert.deepStrictEqual(JSON.parse(run.out), { viewer: 'claude-desktop', call: 'preview_start', url: 'u' })
      assert.deepStrictEqual(w.ran(), [])
    }),
  )
})

describe('lntt browser', () => {
  it.effect('--json in an Orca worktree: the orca driver, on the worktree port and browser', () =>
    Effect.gen(function* () {
      const run = yield* world({ at: LINKED, path: ['orca'] }).lntt({
        kind: 'browser',
        json: true,
        env: { TERM_PROGRAM: 'Orca' },
      })
      assert.strictEqual(run.code, 0, run.err)
      const plan = JSON.parse(run.out)
      assert.deepStrictEqual(
        [plan.host, plan.driver, plan.app, plan.url, plan.kind],
        ['orca', 'orca', 'web', 'http://localhost:5183', 'shell'],
      )
      assert.strictEqual(
        plan.operations.open.command,
        `orca goto --url http://localhost:5183 --worktree path:${LINKED} --json`,
      )
    }),
  )

  it.effect('without --json, the plan as a document, its last line ending the output', () =>
    Effect.gen(function* () {
      const run = yield* world().lntt({ kind: 'browser' })
      assert.strictEqual(run.code, 0)
      assert.match(run.out, /^Driver playwright, on host terminal/)
      assert.match(run.out, /\nclose {7}\S/)
      assert.isFalse(run.out.endsWith('\n'))
    }),
  )

  it.effect('the operator’s preference is read from workspace.browsers', () =>
    Effect.gen(function* () {
      const files = { [`${HOME}/.agents/operator.jsonc`]: '{"workspace":{"browsers":["chrome"]}}' }
      const run = yield* world({ files }).lntt({ kind: 'browser', json: true })
      assert.strictEqual(JSON.parse(run.out).driver, 'chrome')
    }),
  )

  it.effect('with several apps the app must be named; an unknown one names those there are; both exit 1', () =>
    Effect.gen(function* () {
      const several = yield* world({ apps: { web: WEB, admin: { ...WEB, port: 5174 } } }).lntt({ kind: 'browser' })
      assert.deepStrictEqual(
        [several.code, several.err],
        [1, 'lntt: name the app: pnpm exec lntt browser <app> (local.apps: web, admin)'],
      )
      const unknown = yield* world().lntt({ kind: 'browser', app: 'nope' })
      assert.deepStrictEqual([unknown.code, unknown.err], [1, 'lntt: no app nope in local.apps (web)'])
    }),
  )

  it.effect('with a query nothing is printed: the plan waits for the query, exit 0', () =>
    Effect.gen(function* () {
      const parsed = { kind: 'browser', query: '.driver', json: false } as const
      const run = yield* world().lntt(parsed)
      assert.deepStrictEqual([run.code, run.out], [null, ''])
      const query = queryOf(
        { ...parsed, cwd: MAIN, home: HOME, env: {}, platform: 'darwin', tmp: '/tmp' },
        run.input as string,
      )
      assert.deepStrictEqual(
        [query.expression, query.code, query.command, JSON.parse(query.input).app],
        ['.driver', 0, 'lntt browser', 'web'],
      )
    }),
  )
})
