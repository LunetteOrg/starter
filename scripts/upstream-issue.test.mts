import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Gh } from '../packages/lntt/src/ci/candidate.ts'
import { boardTarget, type Failure, failingTests, report, type Target } from './upstream-issue.mts'

// The end of a red `pnpm --filter @lntt/lntt test:upstream`, as node --test prints it.
const RED = `▶ opencode
  ✔ every flag lntt passes to opencode is in its --help (331.341143ms)
  ✖ a one-line call on a free model answers with the JSON lntt reads: text, session, tokens (4154.1914ms)
✖ opencode (4487.002403ms)
ℹ tests 11
ℹ fail 1

\x1b[31m✖ failing tests:\x1b[39m

test at test/upstream-opencode.test.ts:32:3
✖ a one-line call on a free model answers with the JSON lntt reads: text, session, tokens (4154.1914ms)
  AssertionError [ERR_ASSERTION]: lntt read no token count from opencode's events:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @lntt/lntt@0.6.2 test:upstream
`
const TEST_STEP = 'the upstream test (packages/lntt/test/upstream-opencode.test.ts)'

const failure = (fields: Partial<Failure> = {}): Failure => ({
  tool: 'opencode',
  version: '2.2.1',
  step: TEST_STEP,
  run: 'https://github.com/o/r/actions/runs/1',
  log: RED,
  ...fields,
})

const target: Target = {
  type: 'Bug',
  project: { owner: 'Org', ownerType: 'organization', number: 1 },
  status: { field: 'Status', option: 'Todo' },
}

// A gh that answers each read from the first key its command line contains, and
// records every write; `created` is what the REST create answers, or a function of its
// payload that answers or throws.
function fakeGh(
  answers: Record<string, unknown>,
  created: unknown = { number: 9, node_id: 'I_9', html_url: 'u', type: { name: 'Bug' } },
) {
  const writes: Array<{ args: string; input?: string }> = []
  const gh: Gh & { writes: typeof writes } = {
    writes,
    read: (args) => {
      const line = args.join(' ')
      const key = Object.keys(answers).find((k) => line.includes(k))
      if (key === undefined) throw new Error(`unexpected read: ${line}`)
      const answer = answers[key]
      if (answer instanceof Error) throw answer
      return typeof answer === 'string' ? answer : JSON.stringify(answer)
    },
    write: (args, input) => {
      const line = args.join(' ')
      writes.push({ args: line, input })
      if (line.includes('repos/o/r/issues --method POST')) {
        const answer = typeof created === 'function' ? created(JSON.parse(input ?? '{}')) : created
        return typeof answer === 'string' ? answer : JSON.stringify(answer)
      }
      const key = Object.keys(answers).find((k) => line.includes(k))
      const answer = key === undefined ? '' : answers[key]
      if (answer instanceof Error) throw answer
      return typeof answer === 'string' ? answer : JSON.stringify(answer)
    },
  }
  return gh
}

// No issue with the title, and `open` as the open issues.
const issues = (open: Array<{ number: number; body: string }> = []) => ({
  'in:title': [],
  '--state open': open,
})

// The Project, its Status field, the item it adds and the item read back.
const project = (options = ['Todo', 'Done'], current = 'Todo') => ({
  'projectV2(number': {
    data: {
      organization: {
        projectV2: {
          id: 'P',
          title: 'roadmap',
          field: { id: 'F', options: options.map((o) => ({ id: `o-${o}`, name: o })) },
        },
      },
    },
  },
  addProjectV2ItemById: { data: { addProjectV2ItemById: { item: { id: 'IT' } } } },
  updateProjectV2ItemFieldValue: { data: {} },
  'node(id:': { data: { node: { fieldValueByName: { name: current } } } },
})

const lines = () => {
  const out: string[] = []
  return { out, log: (line: string) => out.push(line) }
}

describe('failingTests', () => {
  test('reads the names under "failing tests", without their durations or colors', () => {
    assert.deepEqual(failingTests(RED), [
      'a one-line call on a free model answers with the JSON lntt reads: text, session, tokens',
    ])
  })

  test('a log with no failing tests section has none', () => {
    assert.deepEqual(failingTests('Err: no matching version\n'), [])
  })

  test('several failures are sorted and counted once', () => {
    const log = '✖ failing tests:\n\ntest at a:1:1\n✖ b two (1ms)\ntest at a:2:1\n✖ a one (2.5ms)\n✖ b two (1ms)\n'
    assert.deepEqual(failingTests(log), ['a one', 'b two'])
  })
})

describe('boardTarget', () => {
  test('the Bug type, the Project and the status field with its initial role, from board', () => {
    const board = {
      github: { project: { owner: 'Org', ownerType: 'organization', number: 1 } },
      issueTypes: { parents: ['Feature'], children: ['Task', 'Bug'] },
      fields: { status: { name: 'Status', options: ['Todo', 'Ready'], initial: 'Ready' } },
    }
    assert.deepEqual(boardTarget(board), {
      type: 'Bug',
      project: { owner: 'Org', ownerType: 'organization', number: 1 },
      status: { field: 'Status', option: 'Ready' },
    })
  })

  test('the initial role defaults to the first option; no Bug type and no project leave them out', () => {
    const board = { issueTypes: { children: ['Task'] }, fields: { status: { name: 'Stato', options: ['Da fare'] } } }
    assert.deepEqual(boardTarget(board), { status: { field: 'Stato', option: 'Da fare' } })
    assert.deepEqual(boardTarget(undefined), {})
  })
})

describe('report', () => {
  test('a red opens the issue typed Bug, adds it to the Project at the initial status, Priority untouched', () => {
    const gh = fakeGh(issues())
    const board = fakeGh(project())
    const { out, log } = lines()
    const result = report({ gh, board, repo: 'o/r', target, log }, failure())
    assert.deepEqual(result, { action: 'opened', number: 9 })

    assert.equal(gh.writes.length, 1)
    const payload = JSON.parse(gh.writes[0]?.input ?? '{}')
    assert.equal(payload.title, 'opencode 2.2.1 breaks lntt')
    assert.equal(payload.type, 'Bug')
    assert.match(payload.body, /failed at \*\*the upstream test/)
    assert.match(payload.body, /- a one-line call on a free model answers/)
    assert.match(payload.body, /Run: https:\/\/github\.com\/o\/r\/actions\/runs\/1/)
    assert.match(payload.body, /ERR_ASSERTION/)
    assert.ok(!payload.body.includes('\u001b'))
    assert.match(payload.body, /<!-- upstream-failure: opencode: test: a one-line call/)

    const writes = board.writes.map((w) => w.args)
    assert.equal(writes.length, 2)
    assert.match(writes[0] ?? '', /addProjectV2ItemById.*project=P -f content=I_9/s)
    assert.match(writes[1] ?? '', /updateProjectV2ItemFieldValue.*item=IT -f field=F -f option=o-Todo/s)
    assert.doesNotMatch(writes.join('\n'), /Priority/)
    assert.match(out.join('\n'), /#9 on the Project at "Todo"/)
    assert.doesNotMatch(out.join('\n'), /::notice/)
  })

  test('a red already reported for the same tool at the same test comments on the open issue and opens none', () => {
    const opened = fakeGh(issues())
    report({ gh: opened, board: fakeGh(project()), repo: 'o/r', target, log: () => {} }, failure())
    const body = JSON.parse(opened.writes[0]?.input ?? '{}').body as string

    const gh = fakeGh({ ...issues([{ number: 185, body }]), 'issues/185/comments': '' })
    const board = fakeGh(project())
    const { out, log } = lines()
    const result = report({ gh, board, repo: 'o/r', target, log }, failure({ version: '2.2.4' }))
    assert.deepEqual(result, { action: 'commented', number: 185 })
    assert.equal(gh.writes.length, 1)
    assert.match(gh.writes[0]?.args ?? '', /^issue comment 185 --repo o\/r --body-file -$/)
    assert.match(gh.writes[0]?.input ?? '', /opencode 2\.2\.4 fails the same way/)
    assert.match(gh.writes[0]?.input ?? '', /Run: https:\/\/github\.com\/o\/r\/actions\/runs\/1/)
    assert.match(gh.writes[0]?.input ?? '', /ERR_ASSERTION/)
    assert.match(gh.writes[0]?.input ?? '', /<!-- upstream-version: opencode 2\.2\.4 -->/)
    assert.deepEqual(board.writes, [])
    assert.match(out.join('\n'), /#185 reports the same failure/)
  })

  test('the same version already added to the open issue adds nothing', () => {
    const body =
      '<!-- upstream-failure: opencode: test: a one-line call on a free model answers with the JSON lntt reads: text, session, tokens -->'
    const gh = fakeGh({
      ...issues([{ number: 185, body }]),
      'issues/185/comments': 'x\n<!-- upstream-version: opencode 2.2.4 -->',
    })
    const result = report({ gh, repo: 'o/r', target, log: () => {} }, failure({ version: '2.2.4' }))
    assert.deepEqual(result, { action: 'none', number: 185 })
    assert.deepEqual(gh.writes, [])
  })

  test('a red at another test, or of another tool, opens its own issue', () => {
    const body = '<!-- upstream-failure: opencode: test: another test -->'
    const gh = fakeGh(issues([{ number: 185, body }]))
    assert.equal(report({ gh, repo: 'o/r', target, log: () => {} }, failure()).action, 'opened')

    const mine = '<!-- upstream-failure: opencode: step: scripts/upstream-install.sh -->'
    const other = fakeGh(issues([{ number: 185, body: mine }]))
    const red = failure({ tool: 'orca', step: 'scripts/upstream-install.sh', log: 'curl: (22) 404\n' })
    assert.equal(report({ gh: other, repo: 'o/r', target, log: () => {} }, red).action, 'opened')
    assert.match(
      JSON.parse(other.writes[0]?.input ?? '{}').body,
      /upstream-failure: orca: step: scripts\/upstream-install\.sh/,
    )
  })

  test('an issue with the title of this tool and version, open or closed, stops a second one', () => {
    const gh = fakeGh({ 'in:title': [{ number: 186, title: 'opencode 2.2.1 breaks lntt' }] })
    const { out, log } = lines()
    assert.deepEqual(report({ gh, repo: 'o/r', target, log }, failure()), { action: 'none', number: 186 })
    assert.deepEqual(gh.writes, [])
    assert.match(out.join('\n'), /#186 is named "opencode 2\.2\.1 breaks lntt": none opened/)
  })

  test('a search hit whose title only contains this one is not the same issue', () => {
    const gh = fakeGh({ ...issues(), 'in:title': [{ number: 3, title: 'opencode 2.2.10 breaks lntt' }] })
    assert.equal(report({ gh, repo: 'o/r', target, log: () => {} }, failure()).action, 'opened')
  })

  test('without the Projects token the issue is opened anyway, with a notice that it is off the board', () => {
    const gh = fakeGh(issues())
    const { out, log } = lines()
    assert.deepEqual(report({ gh, repo: 'o/r', target, log }, failure()), { action: 'opened', number: 9 })
    assert.match(out.join('\n'), /::notice title=Issue off the board::#9 .*no token with the Projects permission/)
  })

  test('a Projects token the API refuses leaves the issue opened, with the notice', () => {
    const gh = fakeGh(issues())
    const board = fakeGh({
      'projectV2(number': new Error('Command failed: gh api graphql: Resource not accessible by integration'),
    })
    const { out, log } = lines()
    assert.equal(report({ gh, board, repo: 'o/r', target, log }, failure()).action, 'opened')
    assert.match(out.join('\n'), /::notice title=Issue off the board::#9 .*Resource not accessible/)
  })

  test('a status the Project lacks leaves the item where it is, with a notice', () => {
    const gh = fakeGh(issues())
    const board = fakeGh(project(['Backlog', 'Done'], 'Backlog'))
    const { out, log } = lines()
    report({ gh, board, repo: 'o/r', target, log }, failure())
    assert.equal(board.writes.length, 1)
    assert.match(out.join('\n'), /::notice title=Status not set::"Todo" is not an option of Status/)
  })

  test('a type GitHub dropped is told in a notice', () => {
    const gh = fakeGh(issues(), { number: 9, node_id: 'I_9', html_url: 'u', type: null })
    const { out, log } = lines()
    report({ gh, repo: 'o/r', target, log }, failure())
    assert.match(out.join('\n'), /::notice title=Issue untyped::#9 has no type: GitHub dropped "Bug"/)
  })

  test('with no Bug in board.issueTypes the issue is opened with no type', () => {
    const gh = fakeGh(issues())
    const { out, log } = lines()
    report({ gh, repo: 'o/r', target: { ...target, type: undefined }, log }, failure())
    assert.equal(JSON.parse(gh.writes[0]?.input ?? '{}').type, undefined)
    assert.match(out.join('\n'), /::notice title=Issue untyped::board\.issueTypes names no Bug: #9 has no type/)
  })
  test('the issue quotes only the last 80 lines of the log', () => {
    const gh = fakeGh(issues())
    const log = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n')
    report({ gh, repo: 'o/r', target, log: () => {} }, failure({ log }))
    const body = JSON.parse(gh.writes[0]?.input ?? '{}').body as string
    assert.match(body, /^line 121$/m)
    assert.match(body, /^line 200$/m)
    assert.doesNotMatch(body, /^line 120$/m)
  })

  test('a test name with -- does not end the marker early', () => {
    const gh = fakeGh(issues())
    const log = '✖ failing tests:\n\n✖ a --flag --> b (1ms)\n'
    report({ gh, repo: 'o/r', target, log: () => {} }, failure({ log }))
    const body = JSON.parse(gh.writes[0]?.input ?? '{}').body as string
    const marker = body.split('\n').find((l) => l.startsWith('<!-- upstream-failure'))
    assert.equal(marker, '<!-- upstream-failure: opencode: test: a - -flag - -> b -->')
  })

  test('a dry run creates nothing and puts nothing on the board', () => {
    const gh = fakeGh(issues(), '')
    const board = fakeGh(project())
    assert.deepEqual(report({ gh, board, repo: 'o/r', target, log: () => {} }, failure()), { action: 'opened' })
    assert.deepEqual(board.writes, [])
  })

  test('a type GitHub refuses opens the issue without it, with a notice', () => {
    const gh = fakeGh(issues(), (payload: { type?: string }) => {
      if (payload.type) throw new Error('Command failed: gh api repos/o/r/issues: HTTP 422 Validation Failed')
      return { number: 9, node_id: 'I_9', html_url: 'u', type: null }
    })
    const { out, log } = lines()
    assert.deepEqual(report({ gh, repo: 'o/r', target: { type: 'Bug' }, log }, failure()), {
      action: 'opened',
      number: 9,
    })
    assert.equal(gh.writes.length, 2)
    assert.equal(JSON.parse(gh.writes[1]?.input ?? '{}').type, undefined)
    assert.match(
      out.join('\n'),
      /::notice title=Issue untyped::GitHub refused the issue with the type "Bug", so it is opened without it: .*422/,
    )
    assert.doesNotMatch(out.join('\n'), /GitHub dropped/)
  })

  test('a failure after the item is added says the status is unset, not that the issue is off the board', () => {
    const gh = fakeGh(issues())
    const board = fakeGh({
      ...project(),
      updateProjectV2ItemFieldValue: new Error('Command failed: gh api graphql: timeout'),
    })
    const { out, log } = lines()
    report({ gh, board, repo: 'o/r', target, log }, failure())
    assert.match(out.join('\n'), /::notice title=Status not set::#9 is on the Project with its status unset: .*timeout/)
    assert.doesNotMatch(out.join('\n'), /off the board/)
  })
  test('a create that fails for another reason, or with no type to drop, is not retried', () => {
    const down = () => {
      throw new Error('Command failed: gh api repos/o/r/issues: HTTP 502 Bad Gateway')
    }
    const gh = fakeGh(issues(), down)
    assert.throws(() => report({ gh, repo: 'o/r', target, log: () => {} }, failure()), /502/)
    assert.equal(gh.writes.length, 1)

    const refused = () => {
      throw new Error('Command failed: gh api repos/o/r/issues: HTTP 422 Validation Failed')
    }
    const untyped = fakeGh(issues(), refused)
    assert.throws(() => report({ gh: untyped, repo: 'o/r', target: {}, log: () => {} }, failure()), /422/)
    assert.equal(untyped.writes.length, 1)
  })

  test('a read-back with no item logs no status, not a failure', () => {
    const gh = fakeGh(issues())
    const board = fakeGh({ ...project(), 'node(id:': { data: { node: null } } })
    const { out, log } = lines()
    report({ gh, board, repo: 'o/r', target, log }, failure())
    assert.match(out.join('\n'), /#9 on the Project at "no status"/)
    assert.doesNotMatch(out.join('\n'), /::notice/)
  })
})
