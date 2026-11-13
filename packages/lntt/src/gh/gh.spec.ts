import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PlatformError from 'effect/PlatformError'
import { type ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import { Gh, ghAt } from './gh.ts'

const encode = (text: string) => new TextEncoder().encode(text)

// gh as a spawner in memory: what it was asked and where, and its answer by its arguments.
function gh(
  answer: (args: string[]) => { out?: string; err?: string; code?: number } | 'missing' | 'refused',
  dir?: string,
) {
  const asked: string[][] = []
  const cwds: (string | undefined)[] = []
  // What each call got on its stdin, '' for none.
  const inputs: string[] = []
  const spawn = (command: ChildProcess.Command) =>
    Effect.gen(function* () {
      if (command._tag !== 'StandardCommand') return yield* Effect.die('a piped command')
      const args = command.args.map(String)
      asked.push([command.command, ...args])
      cwds.push(command.options.cwd)
      const stdin = command.options.stdin
      inputs.push(
        Stream.isStream(stdin)
          ? yield* Stream.mkString(Stream.decodeText(stdin as Stream.Stream<Uint8Array>)).pipe(Effect.orDie)
          : '',
      )
      const said = answer(args)
      if (said === 'missing' || said === 'refused')
        return yield* PlatformError.systemError({
          _tag: said === 'missing' ? 'NotFound' : 'PermissionDenied',
          module: 'ChildProcess',
          method: 'spawn',
          pathOrDescriptor: 'gh',
        })
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(said.code ?? 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(encode(said.out ?? '')),
        stderr: Stream.make(encode(said.err ?? '')),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    })
  const layer = ghAt(dir).pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.make(spawn))),
  )
  return { asked, cwds, inputs, layer }
}

describe('Gh on the machine', () => {
  it.effect('each operation asks gh what it says it asks, in the directory given, and reads its JSON', () => {
    const g = gh(
      (args) =>
        args[0] === 'repo'
          ? { out: 'org/repo\n' }
          : args[0] === 'pr'
            ? { out: '[{"number":3,"headRefName":"candidate/13"}]' }
            : { out: '{"title":"T","labels":[],"type":null}' },
      '/repo',
    )
    return Effect.gen(function* () {
      const github = yield* Gh
      assert.strictEqual(yield* github.repository, 'org/repo')
      assert.deepStrictEqual(
        yield* github.openPullRequests({ repo: 'org/repo', base: 'main', search: 'head:candidate/' }),
        [{ number: 3, headRefName: 'candidate/13' }],
      )
      assert.deepStrictEqual(yield* github.issue(7), { title: 'T', labels: [], type: null })
      assert.deepStrictEqual(g.asked, [
        ['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
        [
          'gh',
          'pr',
          'list',
          '--repo',
          'org/repo',
          '--state',
          'open',
          '--base',
          'main',
          '--search',
          'head:candidate/',
          '--json',
          'number,headRefName',
        ],
        ['gh', 'api', 'repos/{owner}/{repo}/issues/7'],
      ])
      assert.deepStrictEqual(g.cwds, ['/repo', '/repo', '/repo'])
    }).pipe(Effect.provide(g.layer))
  })

  it.effect('a gh that exits non-zero, cannot start, or answers no JSON is a GhError that says so', () =>
    Effect.gen(function* () {
      const refused = gh(() => ({ err: 'HTTP 403: Resource not accessible by integration\n', code: 1 }))
      const error = yield* Effect.flip(Effect.flatMap(Gh, (g) => g.issue(7)).pipe(Effect.provide(refused.layer)))
      assert.strictEqual(error._tag, 'GhError')
      assert.strictEqual(
        error.message,
        'gh api repos/{owner}/{repo}/issues/7 failed: HTTP 403: Resource not accessible by integration',
      )
      const missing = gh(() => 'missing')
      const gone = yield* Effect.flip(Effect.flatMap(Gh, (g) => g.repository).pipe(Effect.provide(missing.layer)))
      assert.strictEqual(gone._tag, 'GhError')
      const garbled = gh(() => ({ out: '<html>' }))
      const notJson = yield* Effect.flip(Effect.flatMap(Gh, (g) => g.issue(7)).pipe(Effect.provide(garbled.layer)))
      assert.match(notJson.message, /not JSON: <html>/)
    }),
  )

  it.effect('the writes give the body on stdin, and the reads parse what gh prints', () => {
    const g = gh((args) => {
      if (args[1] === 'graphql') return { out: '{"data":{"viewer":{"login":"me"}}}' }
      if (args[0] === 'issue' && args[1] === 'list') return { out: '[{"number":4,"title":"T","url":"https://x/4"}]' }
      if (args[1] === '--paginate') return { out: '{"id":1,"body":"a"}\n{"id":2,"body":"b"}\n' }
      if (args[0] === 'api' && args[2] === '--jq') return { out: 'A title\thttps://github.com/o/r/issues/5\n' }
      return { out: 'https://github.com/o/r/issues/9' }
    })
    return Effect.gen(function* () {
      const github = yield* Gh
      assert.deepStrictEqual(yield* github.graphql('query{ viewer{ login } }', { n: 1 }), {
        viewer: { login: 'me' },
      })
      assert.deepStrictEqual(yield* github.searchIssues({ repo: 'o/r', words: 'lock held' }), [
        { number: 4, title: 'T', url: 'https://x/4' },
      ])
      assert.deepStrictEqual(yield* github.issueComments({ repo: 'o/r', number: 3 }), [
        { id: 1, body: 'a' },
        { id: 2, body: 'b' },
      ])
      assert.deepStrictEqual(yield* github.issueLink({ repo: 'o/r', number: 5 }), {
        title: 'A title',
        url: 'https://github.com/o/r/issues/5',
      })
      assert.strictEqual(
        yield* github.createIssue({ repo: 'o/r', title: 'T', body: 'B1' }),
        'https://github.com/o/r/issues/9',
      )
      yield* github.commentIssue({ repo: 'o/r', number: 9, body: 'B2' })
      yield* github.commentPullRequest({ repo: 'o/r', number: 8, body: 'B3' })
      yield* github.updateComment({ repo: 'o/r', id: 7, body: 'B4' })
      assert.deepStrictEqual(g.asked, [
        ['gh', 'api', 'graphql', '--input', '-'],
        [
          'gh',
          'issue',
          'list',
          '--repo',
          'o/r',
          '--state',
          'open',
          '--search',
          'lock held',
          '--json',
          'number,title,url',
          '--limit',
          '20',
        ],
        ['gh', 'api', '--paginate', 'repos/o/r/issues/3/comments', '--jq', '.[] | {id, body}'],
        ['gh', 'api', 'repos/o/r/issues/5', '--jq', '[.title, .html_url] | @tsv'],
        ['gh', 'issue', 'create', '--repo', 'o/r', '--title', 'T', '--body-file', '-'],
        ['gh', 'issue', 'comment', '9', '--repo', 'o/r', '--body-file', '-'],
        ['gh', 'pr', 'comment', '8', '--repo', 'o/r', '--body-file', '-'],
        ['gh', 'api', '-X', 'PATCH', 'repos/o/r/issues/comments/7', '--input', '-'],
      ])
      assert.deepStrictEqual(g.inputs, [
        JSON.stringify({ query: 'query{ viewer{ login } }', variables: { n: 1 } }),
        '',
        '',
        '',
        'B1',
        'B2',
        'B3',
        JSON.stringify({ body: 'B4' }),
      ])
    }).pipe(Effect.provide(g.layer))
  })

  it.effect('a GraphQL answer with errors is a GhError of their messages; a missing gh says so', () =>
    Effect.gen(function* () {
      const refused = gh(() => ({ out: '{"errors":[{"message":"no field x"},{"message":"no field y"}]}' }))
      const error = yield* Effect.flip(
        Effect.flatMap(Gh, (g) => g.graphql('q', {})).pipe(Effect.provide(refused.layer)),
      )
      assert.strictEqual(error.output, 'no field x; no field y')
      assert.notStrictEqual(error.missing, true)
      const missing = gh(() => 'missing')
      const gone = yield* Effect.flip(
        Effect.flatMap(Gh, (g) => g.issueLink({ repo: 'o/r', number: 1 })).pipe(Effect.provide(missing.layer)),
      )
      assert.strictEqual(gone.missing, true)
      const refusedStart = gh(() => 'refused')
      const denied = yield* Effect.flip(
        Effect.flatMap(Gh, (g) => g.issueLink({ repo: 'o/r', number: 1 })).pipe(Effect.provide(refusedStart.layer)),
      )
      assert.strictEqual(denied.missing, false, 'gh is there, it could not start')
    }),
  )

  it.effect('a search with no match is no issue; a failure with nothing on stderr says what is on stdout', () =>
    Effect.gen(function* () {
      const empty = gh(() => ({ out: '' }))
      const none = yield* Effect.flatMap(Gh, (g) => g.searchIssues({ repo: 'o/r', words: 'x' })).pipe(
        Effect.provide(empty.layer),
      )
      assert.deepStrictEqual(none, [])
      const body = gh(() => ({ out: '{"message":"Not Found"}', code: 1 }))
      const error = yield* Effect.flip(Effect.flatMap(Gh, (g) => g.issue(7)).pipe(Effect.provide(body.layer)))
      assert.strictEqual(error.output, '{"message":"Not Found"}')
    }),
  )

  it.effect("a pull request's body and head: the one named, else the current branch's", () => {
    const g = gh(() => ({ out: '{"number":7,"body":null,"headRefName":"feat/7/x"}' }))
    return Effect.gen(function* () {
      const github = yield* Gh
      assert.deepStrictEqual(yield* github.pullRequest(7), { number: 7, body: null, headRefName: 'feat/7/x' })
      yield* github.pullRequest()
      assert.deepStrictEqual(g.asked, [
        ['gh', 'pr', 'view', '7', '--json', 'number,body,headRefName'],
        ['gh', 'pr', 'view', '--json', 'number,body,headRefName'],
      ])
    }).pipe(Effect.provide(g.layer))
  })

  it.effect('in memory, an operation not given fails as gh would without a connection', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Effect.flatMap(Gh, (g) => g.repository).pipe(Effect.provide(Gh.memory({}))))
      assert.strictEqual(error._tag, 'GhError')
    }),
  )
})
