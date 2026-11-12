import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as TestConsole from 'effect/testing/TestConsole'
import { type Dump, withAgent } from '../dump.ts'
import { Gh, type IssueHit } from '../gh/gh.ts'
import { Git } from '../git/git.ts'
import { memoryFileSystem } from '../testing/file-system.ts'
import { command, IssueBridge, type IssueCommand } from './command.ts'

const ROOT = '/home/me/app'

const DRAFT = [
  '# lntt review loses its state when the worktree changes branch',
  '',
  '## What happened',
  'The round started from zero after `git switch`.',
  '',
  '## Pull requests',
  '- acme/app#12',
  '- acme/app#15',
  '',
  '## Proposal',
  'Key the state by worktree, not by branch.',
].join('\n')

const DUMP: Dump = {
  sections: [
    { title: 'lntt', lines: ['version: 0.6.2', 'installed: a dependency of the project'] },
    { title: 'Runtime', lines: ['Node: v24.1.0', 'package manager: pnpm@10.16.1', 'OS: Darwin 27.0.0 arm64'] },
    { title: 'Harness', lines: ['harness: Claude Code 2.3.4', 'model: claude-opus-5-5'] },
  ],
  harness: 'Claude Code 2.3.4',
  model: 'claude-opus-5-5',
  lntt: '0.6.2',
}

const UPSTREAM = { cycle: { retrospective: { upstream: { repository: 'LunetteOrg/starter' } } } }

// A project with a draft, GitHub that records what it is asked, and the origin remote.
function world() {
  const state = {
    config: structuredClone(UPSTREAM) as Record<string, unknown>,
    origin: '',
    collected: 0,
    // What the configuration's loader throws, for one that does not validate.
    refused: null as string | null,
  }
  const asked: string[] = []
  const writes: { args: string; body: string }[] = []
  const fs = memoryFileSystem({ dirs: [ROOT] })
  const put = (path: string, text: string) => fs.put(`${ROOT}/${path}`, text)
  const hits: IssueHit[] = [{ number: 7, title: 't', url: 'u' }]
  const layer = Layer.mergeAll(
    fs.layer,
    Git.memory({ originUrl: Effect.sync(() => state.origin) }),
    Gh.memory({
      searchIssues: ({ repo, words }) =>
        Effect.sync(() => {
          asked.push(`issue list --repo ${repo} --search ${words}`)
          return hits
        }),
      createIssue: ({ repo, title, body }) =>
        Effect.sync(() => {
          writes.push({ args: `issue create --repo ${repo} --title ${title}`, body })
          return 'https://github.com/LunetteOrg/starter/issues/9'
        }),
      commentIssue: ({ repo, number, body }) =>
        Effect.sync(() => {
          writes.push({ args: `issue comment ${number} --repo ${repo}`, body })
          return 'https://github.com/LunetteOrg/starter/issues/7#c'
        }),
    }),
  )
  // One run of `lntt issue`: its exit code, stdout and stderr.
  const lntt = (parsed: Partial<Extract<IssueCommand, { kind: 'file' }>> = {}, env: Record<string, string> = {}) =>
    run({ kind: 'file', draft: { path: `${ROOT}/draft.md` }, send: false, env, ...parsed })
  const run = (parsed: IssueCommand) =>
    Effect.gen(function* () {
      const code = yield* command(parsed)
      const out = (yield* TestConsole.logLines).map((line) => `${line}\n`).join('')
      const err = (yield* TestConsole.errorLines).map((line) => `${line}\n`).join('')
      return { code, out, err }
    }).pipe(
      Effect.provideService(IssueBridge, {
        project: () => {
          if (state.refused !== null) throw new Error(state.refused)
          return { root: ROOT, config: state.config }
        },
        collect: ({ harness, model }) => {
          state.collected++
          return withAgent(DUMP, { ...(harness ? { harness } : {}), ...(model ? { model } : {}) })
        },
        redaction: () => ({ home: '/home/me', remotes: [], secrets: [] }),
      }),
      Effect.provide(Layer.mergeAll(layer, Layer.fresh(TestConsole.layer))),
    )
  const ready = Effect.all([put('draft.md', DRAFT), put('package.json', '{"name":"acme-app"}')])
  return { state, asked, writes, put, lntt, run, ready }
}

describe('lntt issue', () => {
  it.effect('without --send it prints the whole issue and sends nothing', () =>
    Effect.gen(function* () {
      const w = world()
      yield* w.ready
      const r = yield* w.lntt({ model: 'm1' })
      assert.strictEqual(r.code, 0, r.err)
      assert.match(r.out, /^To LunetteOrg\/starter: lntt review loses its state/)
      assert.match(r.out, /### Model\n\nm1\n/)
      assert.match(r.out, /### Project\n\nacme-app\n/)
      assert.match(r.out, /<\/details>\n$/, 'printed as it is, with no newline added')
      assert.match(r.err, /nothing sent: --send opens it/)
      assert.deepStrictEqual(w.writes, [])
    }),
  )

  it.effect('--send opens it on the upstream repository and prints its URL; a draft may come as text', () =>
    Effect.gen(function* () {
      const w = world()
      yield* w.ready
      const r = yield* w.lntt({ draft: { text: DRAFT }, send: true })
      assert.strictEqual(r.code, 0, r.err)
      assert.strictEqual(r.out, 'https://github.com/LunetteOrg/starter/issues/9\n')
      assert.match(
        w.writes[0]?.args ?? '',
        /^issue create --repo LunetteOrg\/starter --title lntt review loses its state/,
      )
      assert.match(w.writes[0]?.body ?? '', /### What happened\n\nThe round started from zero/)
    }),
  )

  it.effect('--comment <n> comments on an existing issue instead; its dry run names the issue', () =>
    Effect.gen(function* () {
      const w = world()
      yield* w.ready
      const dry = yield* w.lntt({ comment: 7 })
      assert.match(dry.out, /^To LunetteOrg\/starter#7, as a comment\n/)
      assert.deepStrictEqual(w.writes, [])
      const r = yield* w.lntt({ comment: 7, send: true })
      assert.strictEqual(r.code, 0, r.err)
      assert.strictEqual(w.writes[0]?.args, 'issue comment 7 --repo LunetteOrg/starter')
    }),
  )

  it.effect('--dump reads a dump saved by lntt dump --json; --model given beside it wins', () =>
    Effect.gen(function* () {
      const w = world()
      yield* w.ready
      yield* w.put('dump.json', JSON.stringify(DUMP))
      const r = yield* w.lntt({ dump: `${ROOT}/dump.json` })
      assert.strictEqual(r.code, 0, r.err)
      assert.match(r.out, /### Harness\n\nClaude Code 2\.3\.4\n/)
      assert.strictEqual(w.state.collected, 0, 'the environment is not collected')
      const model = yield* w.lntt({ dump: `${ROOT}/dump.json`, model: 'm9' })
      assert.match(model.out, /### Model\n\nm9\n/)
      assert.match(model.out, /- model: m9/)
      yield* w.put('bad.json', '{"sections":1}')
      const bad = yield* w.lntt({ dump: `${ROOT}/bad.json` })
      assert.strictEqual(bad.code, 1)
      assert.match(bad.err, /bad\.json is not a dump of lntt dump --json/)
    }),
  )

  it.effect('the draft is redacted too: the home path, an email, a token', () =>
    Effect.gen(function* () {
      const w = world()
      yield* w.ready
      yield* w.put(
        'draft.md',
        DRAFT.replace(
          'The round started',
          `In /home/me/app ada@example.com saw ghp_${'a'.repeat(36)}; the round started`,
        ),
      )
      const r = yield* w.lntt()
      assert.strictEqual(r.code, 0, r.err)
      assert.match(r.out, /In ~\/app <email> saw <token>; the round started/)
    }),
  )

  it.effect('a title past what GitHub takes: a warning, a refusal with --send, nothing for a comment', () =>
    Effect.gen(function* () {
      const w = world()
      yield* w.ready
      yield* w.put('draft.md', DRAFT.replace(/^# .*/, `# ${'t'.repeat(257)}`))
      assert.match((yield* w.lntt()).err, /the title is 257 characters/)
      assert.strictEqual((yield* w.lntt({ send: true })).code, 1)
      assert.deepStrictEqual(w.writes, [])
      const comment = yield* w.lntt({ comment: 7, send: true })
      assert.strictEqual(comment.code, 0, comment.err)
      assert.match(w.writes[0]?.args ?? '', /^issue comment 7/)
    }),
  )

  it.effect('a body past what GitHub takes: a warning in the dry run, a refusal with --send', () =>
    Effect.gen(function* () {
      const w = world()
      yield* w.ready
      // Short words: redact (src/dump.ts) takes seconds on one word this long.
      yield* w.put('draft.md', DRAFT.replace('Key the state', `${'x '.repeat(35000)}Key the state`))
      const dry = yield* w.lntt()
      assert.strictEqual(dry.code, 0)
      assert.match(dry.err, /GitHub takes 65536/)
      const send = yield* w.lntt({ send: true })
      assert.strictEqual(send.code, 1)
      assert.match(send.err, /GitHub takes 65536/)
      assert.deepStrictEqual(w.writes, [])
    }),
  )

  it.effect('a draft that does not parse fails before the dump is read; a draft that is not there says so', () =>
    Effect.gen(function* () {
      const w = world()
      yield* w.ready
      yield* w.put('draft.md', '# t\n')
      const r = yield* w.lntt({ dump: `${ROOT}/missing.json` })
      assert.strictEqual(r.code, 1)
      assert.match(r.err, /^lntt issue: the draft has no "## What happened" section/)
      const missing = yield* w.lntt({ draft: { path: `${ROOT}/none.md` } })
      assert.strictEqual(missing.code, 1)
      assert.match(missing.err, /^lntt issue: .*none\.md/)
    }),
  )

  it.effect('a configuration the loader refuses: exit 1 with its message', () =>
    Effect.gen(function* () {
      const w = world()
      yield* w.ready
      w.state.refused = '.agents/config.jsonc: nope is not a key'
      const r = yield* w.lntt()
      assert.strictEqual(r.code, 1)
      assert.strictEqual(r.err, 'lntt issue: .agents/config.jsonc: nope is not a key\n')
    }),
  )

  it.effect('without cycle.retrospective.upstream.repository, it exits 1 naming the key, search too', () =>
    Effect.gen(function* () {
      const w = world()
      yield* w.ready
      w.state.config = {}
      for (const r of [yield* w.lntt(), yield* w.run({ kind: 'search', words: 'x', env: {} })]) {
        assert.strictEqual(r.code, 1)
        assert.match(r.err, /^lntt issue: no cycle\.retrospective\.upstream\.repository in the configuration/)
      }
      assert.deepStrictEqual(w.asked, [])
    }),
  )

  it.effect('the repository of cycle.retrospective.upstream', () =>
    Effect.gen(function* () {
      const w = world()
      yield* w.ready
      w.state.config = { cycle: { retrospective: { upstream: { repository: 'acme/lunette-fork' } } } }
      assert.match((yield* w.lntt()).out, /^To acme\/lunette-fork:/)
    }),
  )

  it.effect('another repository (--repo): printed for the operator to file by hand, never sent', () =>
    Effect.gen(function* () {
      const w = world()
      yield* w.ready
      const dry = yield* w.lntt({ repo: 'remix-run/react-router' })
      assert.strictEqual(dry.code, 0, dry.err)
      assert.match(dry.out, /^To remix-run\/react-router: /)
      assert.match(dry.err, /nothing sent: remix-run\/react-router is not the upstream, the operator files it by hand/)
      for (const extra of [{ send: true }, { comment: 7, send: true }]) {
        const send = yield* w.lntt({ repo: 'remix-run/react-router', ...extra })
        assert.strictEqual(send.code, 1)
        assert.match(
          send.err,
          /is not cycle\.retrospective\.upstream\.repository \(LunetteOrg\/starter\): only that one is sent/,
        )
      }
      const search = yield* w.run({ kind: 'search', words: 'hmr', repo: 'remix-run/react-router', env: {} })
      assert.strictEqual(search.code, 0, search.err)
      assert.deepStrictEqual(w.asked, ['issue list --repo remix-run/react-router --search hmr'])
      assert.deepStrictEqual(w.writes, [])
    }),
  )

  it.effect('the upstream is the repository it runs in: nothing to send, the harvest handles its items here', () =>
    Effect.gen(function* () {
      const w = world()
      yield* w.ready
      w.state.origin = 'git@github.com:lunetteorg/Starter.git'
      for (const extra of [{}, { send: true }, { comment: 7, send: true }]) {
        const r = yield* w.lntt(extra)
        assert.strictEqual(r.code, 0, r.err)
        assert.strictEqual(r.out, '')
        assert.match(r.err, /nothing to send: LunetteOrg\/starter is this repository \(lunetteorg\/Starter\)/)
      }
      assert.deepStrictEqual(w.writes, [])
      assert.strictEqual(w.state.collected, 0, 'nothing is collected for a report that is not sent')
    }),
  )

  it.effect('another repository asked for, in the upstream itself: printed, not dropped', () =>
    Effect.gen(function* () {
      const w = world()
      yield* w.ready
      w.state.origin = 'https://github.com/LunetteOrg/starter'
      const r = yield* w.lntt({ repo: 'remix-run/react-router' })
      assert.strictEqual(r.code, 0, r.err)
      assert.match(r.out, /^To remix-run\/react-router: /)
      assert.notMatch(r.err, /nothing to send/)
    }),
  )

  it.effect('GITHUB_REPOSITORY, in Actions, wins over the origin remote', () =>
    Effect.gen(function* () {
      const w = world()
      yield* w.ready
      w.state.origin = 'git@github.com:acme/app.git'
      const actions = yield* w.lntt({}, { GITHUB_REPOSITORY: 'LunetteOrg/starter' })
      assert.strictEqual(actions.out, '')
      assert.match(actions.err, /nothing to send/)
      w.state.origin = 'git@github.com:LunetteOrg/starter.git'
      const fork = yield* w.lntt({}, { GITHUB_REPOSITORY: 'acme/app' })
      assert.match(fork.out, /^To LunetteOrg\/starter: /)
    }),
  )

  it.effect('the upstream compared ignoring case: --repo lunetteorg/starter is the upstream, and sent', () =>
    Effect.gen(function* () {
      const w = world()
      yield* w.ready
      const r = yield* w.lntt({ repo: 'lunetteorg/starter', send: true })
      assert.strictEqual(r.code, 0, r.err)
      assert.match(w.writes[0]?.args ?? '', /^issue create --repo lunetteorg\/starter /)
    }),
  )

  it.effect('--repo needs no upstream to print or search; --send still names the key', () =>
    Effect.gen(function* () {
      const w = world()
      yield* w.ready
      w.state.config = {}
      const dry = yield* w.lntt({ repo: 'remix-run/react-router' })
      assert.strictEqual(dry.code, 0, dry.err)
      assert.match(dry.out, /^To remix-run\/react-router: /)
      const search = yield* w.run({ kind: 'search', words: 'hmr', repo: 'remix-run/react-router', env: {} })
      assert.strictEqual(search.code, 0)
      const send = yield* w.lntt({ repo: 'remix-run/react-router', send: true })
      assert.strictEqual(send.code, 1)
      assert.match(send.err, /no cycle\.retrospective\.upstream\.repository in the configuration/)
    }),
  )

  it.effect('search prints one JSON line per open issue that matches', () =>
    Effect.gen(function* () {
      const w = world()
      const r = yield* w.run({ kind: 'search', words: 'review state', env: {} })
      assert.strictEqual(r.code, 0, r.err)
      assert.strictEqual(r.out, '{"number":7,"title":"t","url":"u"}\n')
      assert.deepStrictEqual(w.asked, ['issue list --repo LunetteOrg/starter --search review state'])
    }),
  )

  it.effect('a project with no package.json is named after its directory', () =>
    Effect.gen(function* () {
      const w = world()
      yield* w.put('draft.md', DRAFT)
      assert.match((yield* w.lntt()).out, /### Project\n\napp\n/)
    }),
  )
})
