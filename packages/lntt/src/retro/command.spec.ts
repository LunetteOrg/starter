import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as TestConsole from 'effect/testing/TestConsole'
import { type CandidateConfig, retrospectiveComment } from '../ci/candidate.ts'
import { ConfigInvalid, ProjectConfig } from '../config/load.ts'
import { type Comment, Gh, GhError, type PullRequestHead } from '../gh/gh.ts'
import { appendRetro, retrospectiveBlock, retrospectiveRules } from '../pull-request.ts'
import { isCandidate, itemCount } from '../retro.ts'
import { command, projectOf, type RetroCommand } from './command.ts'

const RULES = retrospectiveRules({})
const EMPTY = retrospectiveBlock(RULES)

// A project with a candidate, and one without.
const DATA = { delivery: { candidate: { prefix: 'candidate/' } } }
const NO_CANDIDATE = {}
const config = (projectOf(DATA).candidate as { config: CandidateConfig }).config
// The comment the candidate automation opens a candidate with.
const OPENING = retrospectiveComment(config)
const OPEN = [{ number: 80, headRefName: 'candidate/8' }]

// GitHub in memory for lntt retro: the open pull requests, the comments of each, and the writes
// recorded as gh's command lines. A PATCH changes the comment and `pr comment` adds one, unless
// `lost` drops the write (another append won the race). `read` replaces how the comments of a
// pull request read, and `wrote` runs after each write, for a race of another shape.
function github(
  comments: Record<number, Comment[]> = {},
  {
    open = OPEN as PullRequestHead[],
    lost = 0,
    read,
    wrote,
  }: {
    open?: PullRequestHead[]
    lost?: number
    read?: (pr: number) => Comment[]
    wrote?: (write: { args: string; input: string }) => void
  } = {},
) {
  const writes: { args: string; input: string }[] = []
  const asked: string[] = []
  let drop = lost
  const record = (args: string, input: string) => {
    writes.push({ args, input })
    wrote?.({ args, input })
    return drop-- > 0
  }
  const layer = Gh.memory({
    repository: Effect.succeed('me/mine'),
    openPullRequests: (query) =>
      Effect.sync(() => {
        asked.push(`pr list ${query.repo} ${query.base} ${query.search}`)
        return open
      }),
    issueComments: ({ number }) => Effect.sync(() => structuredClone(read?.(number) ?? comments[number] ?? [])),
    commentPullRequest: ({ repo, number, body }) =>
      Effect.sync(() => {
        if (record(`pr comment ${number} --repo ${repo} --body-file -`, body)) return ''
        if (typeof number !== 'number') return ''
        const all = comments[number] ?? []
        comments[number] = [...all, { id: 100 + all.length, body }]
        return `https://github.com/${repo}/pull/${number}#issuecomment-1`
      }),
    updateComment: ({ repo, id, body }) =>
      Effect.sync(() => {
        if (record(`api -X PATCH repos/${repo}/issues/comments/${id} --input -`, JSON.stringify({ body }))) return
        for (const all of Object.values(comments)) for (const c of all) if (c.id === id) c.body = body
      }),
  })
  return { writes, asked, layer }
}

// One run of `lntt retro add`: its exit code, stdout and stderr.
const retro = (
  gh: ReturnType<typeof github>,
  parsed: Partial<RetroCommand> & { label: string; item: string },
  data: Record<string, unknown> = DATA,
) =>
  Effect.gen(function* () {
    const code = yield* command({ kind: 'add', dryRun: false, repository: 'o/r', ...parsed })
    const out = (yield* TestConsole.logLines).join('\n')
    const err = (yield* TestConsole.errorLines).join('\n')
    return { code, out, err }
  }).pipe(Effect.provide(Layer.mergeAll(gh.layer, ProjectConfig.memory(data), Layer.fresh(TestConsole.layer))))

const body = (write: { input: string } | undefined) => JSON.parse(write?.input ?? '').body as string

describe('isCandidate and itemCount', () => {
  it('a candidate is a branch named by delivery.candidate.prefix and a number', () => {
    assert.strictEqual(isCandidate(config, 'candidate/8'), true)
    assert.strictEqual(isCandidate(config, 'feat/candidate/8'), false)
    assert.strictEqual(isCandidate(null, 'candidate/8'), false)
  })

  it('an item is counted on its label line and as a sub-bullet', () => {
    const one = EMPTY.replace('- **Friction:**', '- **Friction:** x')
    assert.strictEqual(itemCount(one, 'Friction', 'x'), 1)
    assert.strictEqual(itemCount(appendRetro(one, 'Friction', 'x', RULES), 'Friction', 'x'), 2)
    assert.strictEqual(itemCount(EMPTY, 'Friction', 'x'), 0)
  })
})

describe('lntt retro add', () => {
  it.effect('appends to the open candidate’s retrospective comment, edited in place, and says where', () =>
    Effect.gen(function* () {
      const gh = github({
        80: [
          { id: 5, body: 'Moved.' },
          { id: 7, body: OPENING },
        ],
      })
      const r = yield* retro(gh, { label: 'friction', item: 'a CI run\n failed' })
      assert.strictEqual(r.code, 0, r.err)
      assert.strictEqual(r.out, 'retro: added under "Friction" on #80.')
      assert.deepStrictEqual(gh.asked, ['pr list o/r main head:candidate/'])
      assert.strictEqual(gh.writes.length, 1, 'read again, the item is there: one write')
      assert.strictEqual(gh.writes[0]?.args, 'api -X PATCH repos/o/r/issues/comments/7 --input -')
      assert.ok(body(gh.writes[0]).startsWith('The retrospective of this candidate'))
      assert.match(body(gh.writes[0]), /- \*\*Friction:\*\* a CI run failed\n- \*\*To automate/)
    }),
  )

  it.effect('without GITHUB_REPOSITORY the repository comes from gh', () =>
    Effect.gen(function* () {
      const gh = github({ 80: [{ id: 7, body: EMPTY }] })
      const { repository: _, ...parsed } = { repository: '', label: 'friction', item: 'x' }
      const r = yield* command({ kind: 'add', dryRun: false, ...parsed }).pipe(
        Effect.provide(Layer.mergeAll(gh.layer, ProjectConfig.memory(DATA), Layer.fresh(TestConsole.layer))),
      )
      assert.strictEqual(r, 0)
      assert.strictEqual(gh.writes[0]?.args, 'api -X PATCH repos/me/mine/issues/comments/7 --input -')
    }),
  )

  it.effect('--pr names the pull request, and no candidate is looked for', () =>
    Effect.gen(function* () {
      const gh = github({ 12: [{ id: 9, body: EMPTY }] })
      const r = yield* retro(gh, { pr: 12, label: 'rework', item: 'x' }, NO_CANDIDATE)
      assert.strictEqual(r.code, 0, r.err)
      assert.match(r.out, /on #12\./)
      assert.deepStrictEqual(gh.asked, [])
      assert.strictEqual(gh.writes[0]?.args, 'api -X PATCH repos/o/r/issues/comments/9 --input -')
    }),
  )

  it.effect('--pr with no delivery.candidate and no retrospective comment: the empty block, with the item', () =>
    Effect.gen(function* () {
      const gh = github({ 12: [{ id: 3, body: 'Looks good.' }] })
      const r = yield* retro(gh, { pr: 12, label: 'friction', item: 'x' }, NO_CANDIDATE)
      assert.strictEqual(r.out, 'retro: added under "Friction" on #12, in a new retrospective comment.')
      assert.strictEqual(gh.writes[0]?.args, 'pr comment 12 --repo o/r --body-file -')
      assert.strictEqual(gh.writes[0]?.input, appendRetro(EMPTY, 'Friction', 'x', RULES))
    }),
  )

  it.effect('a candidate with no retrospective comment gets one, with the item', () =>
    Effect.gen(function* () {
      const gh = github({ 80: [] })
      const r = yield* retro(gh, { label: 'Friction', item: 'x' })
      assert.strictEqual(r.out, 'retro: added under "Friction" on #80, in a new retrospective comment.')
      assert.strictEqual(gh.writes[0]?.args, 'pr comment 80 --repo o/r --body-file -')
      assert.strictEqual(gh.writes[0]?.input, appendRetro(OPENING, 'Friction', 'x', RULES))
    }),
  )

  it.effect('an append another writer dropped is written again; one never kept is refused', () =>
    Effect.gen(function* () {
      const once = github({ 80: [{ id: 7, body: EMPTY }] }, { lost: 1 })
      assert.strictEqual((yield* retro(once, { label: 'friction', item: 'x' })).code, 0)
      assert.strictEqual(once.writes.length, 2)
      const never = github({ 80: [{ id: 7, body: EMPTY }] }, { lost: 9 })
      const r = yield* retro(never, { label: 'friction', item: 'x' })
      assert.strictEqual(r.code, 1)
      assert.match(r.err, /^lntt retro: the item is not in the retrospective comment of #80 after 3 writes/)
      assert.strictEqual(never.writes.length, 3)
    }),
  )

  it.effect('a sub-bullet append another writer dropped is written again', () =>
    Effect.gen(function* () {
      const first = EMPTY.replace('- **Friction:**', '- **Friction:** first')
      const gh = github({ 80: [{ id: 7, body: first }] }, { lost: 1 })
      yield* retro(gh, { label: 'friction', item: 'second' })
      assert.strictEqual(gh.writes.length, 2)
      assert.match(body(gh.writes[1]), /:\*\*\n {2}- first\n {2}- second\n/)
    }),
  )

  it.effect('an item already in the comment, dropped once, is still written again', () =>
    Effect.gen(function* () {
      const had = EMPTY.replace('- **Friction:**', '- **Friction:** x')
      const gh = github({ 80: [{ id: 7, body: had }] }, { lost: 1 })
      yield* retro(gh, { label: 'friction', item: 'x' })
      assert.strictEqual(gh.writes.length, 2)
    }),
  )

  it.effect('two comments created at once: the item goes into the first, the retrospective one', () =>
    Effect.gen(function* () {
      let listed: Comment[] = []
      const gh = github(
        {},
        {
          read: () => listed,
          wrote: ({ args, input }) => {
            if (args.startsWith('pr comment'))
              listed = [
                { id: 50, body: EMPTY },
                { id: 51, body: input },
              ]
            if (args.includes('PATCH'))
              listed = [
                { id: 50, body: JSON.parse(input).body },
                { id: 51, body: '' },
              ]
          },
          lost: 9,
        },
      )
      const r = yield* retro(gh, { label: 'friction', item: 'x' })
      assert.strictEqual(r.code, 0, r.err)
      assert.notMatch(r.out, /new retrospective comment/, 'the item is in the comment another run created')
      assert.deepStrictEqual(
        gh.writes.map((w) => w.args),
        ['pr comment 80 --repo o/r --body-file -', 'api -X PATCH repos/o/r/issues/comments/50 --input -'],
      )
    }),
  )

  it.effect('a comment gone between two passes: the new one is judged on its own count', () =>
    Effect.gen(function* () {
      const had = EMPTY.replace('- **Friction:**', '- **Friction:** x')
      const reads: Comment[][] = [[{ id: 7, body: had }], []]
      let listed: Comment[] = []
      const gh = github(
        {},
        {
          read: () => reads.shift() ?? listed,
          wrote: ({ args, input }) => {
            if (args.startsWith('pr comment')) listed = [{ id: 9, body: input }]
          },
          lost: 9,
        },
      )
      const r = yield* retro(gh, { label: 'friction', item: 'x' })
      assert.strictEqual(r.code, 0, r.err)
      assert.match(r.out, /in a new retrospective comment/)
      assert.deepStrictEqual(
        gh.writes.map((w) => w.args),
        ['api -X PATCH repos/o/r/issues/comments/7 --input -', 'pr comment 80 --repo o/r --body-file -'],
      )
    }),
  )

  it.effect('a dry run writes nothing, reads nothing back, and says the write it would make', () =>
    Effect.gen(function* () {
      const gh = github({ 80: [{ id: 7, body: EMPTY }] })
      const r = yield* retro(gh, { label: 'friction', item: 'x', dryRun: true })
      assert.strictEqual(r.code, 0, r.err)
      assert.deepStrictEqual(gh.writes, [])
      assert.match(
        r.out,
        /^\[dry-run\] gh api -X PATCH repos\/o\/r\/issues\/comments\/7 --input -\n\[dry-run\] stdin:\n\{"body":/,
      )
      assert.match(r.out, /retro: would add under "Friction" on #80\.$/)
      const created = yield* retro(github({ 80: [] }), { label: 'friction', item: 'two words', dryRun: true })
      assert.match(
        created.out,
        /^\[dry-run\] gh pr comment 80 --repo o\/r --body-file -\n\[dry-run\] stdin:\nThe retrospective/,
      )
    }),
  )

  it.effect('a comment with the start marker and no end marker is refused, nothing written', () =>
    Effect.gen(function* () {
      const gh = github({ 80: [{ id: 7, body: '<!-- retro:start -->\n- **Friction:**' }] })
      const r = yield* retro(gh, { label: 'friction', item: 'x' })
      assert.strictEqual(r.code, 1)
      assert.match(r.err, /no <!-- retro:start --> … <!-- retro:end --> block/)
      assert.deepStrictEqual(gh.writes, [])
    }),
  )

  it.effect('no open candidate: refused, naming --pr, nothing written', () =>
    Effect.gen(function* () {
      const gh = github({}, { open: [{ number: 9, headRefName: 'feat/candidate/9' }] })
      const r = yield* retro(gh, { label: 'friction', item: 'x' })
      assert.strictEqual(r.code, 1)
      assert.match(r.err, /no open candidate \(candidate\/<N> into main\): give the pull request with --pr <n>/)
      const none = yield* retro(gh, { label: 'friction', item: 'x' }, NO_CANDIDATE)
      assert.match(none.err, /no open candidate \(no delivery.candidate\)/)
      assert.deepStrictEqual(gh.writes, [])
    }),
  )

  it.effect('the lowest open candidate is the one written to', () =>
    Effect.gen(function* () {
      const open = [
        { number: 91, headRefName: 'candidate/10' },
        { number: 80, headRefName: 'candidate/8' },
      ]
      const gh = github({ 80: [{ id: 7, body: EMPTY }], 91: [{ id: 8, body: EMPTY }] }, { open })
      assert.match((yield* retro(gh, { label: 'friction', item: 'x' })).out, /on #80\./)
    }),
  )

  it.effect('an unknown label, an empty item, or a configuration refused stops before gh is called', () =>
    Effect.gen(function* () {
      const gh = github()
      const label = yield* retro(gh, { label: 'cost', item: 'x' })
      assert.strictEqual(label.code, 1)
      assert.match(label.err, /^lntt retro: no label "cost": one of Friction, To automate/)
      assert.match((yield* retro(gh, { label: 'friction', item: ' \n' })).err, /empty/)
      const invalid = Layer.succeed(ProjectConfig)(
        ProjectConfig.of({ data: Effect.fail(new ConfigInvalid({ message: 'delivery must be an object' })) }),
      )
      const refused = yield* command({ kind: 'add', dryRun: false, label: 'friction', item: 'x' }).pipe(
        Effect.provide(Layer.mergeAll(gh.layer, invalid, Layer.fresh(TestConsole.layer))),
      )
      assert.strictEqual(refused, 1)
      assert.deepStrictEqual(gh.writes, [])
      assert.deepStrictEqual(gh.asked, [])
    }),
  )

  it.effect('a gh that fails: one line, exit 1', () =>
    Effect.gen(function* () {
      const r = yield* retro(
        {
          ...github(),
          layer: Gh.memory({
            openPullRequests: () => Effect.fail(new GhError({ args: ['pr', 'list'], output: 'HTTP 502' })),
          }),
        },
        { label: 'friction', item: 'x' },
      )
      assert.strictEqual(r.code, 1)
      assert.strictEqual(r.err, 'lntt retro: gh pr list failed: HTTP 502')
    }),
  )
})
