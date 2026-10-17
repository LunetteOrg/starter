import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import {
  agentFor,
  approvals,
  approve,
  type Config,
  childBrief,
  coordinatorBrief,
  gateOf,
  isApproval,
} from '../src/coordinator.ts'

const CONFIG: Config = {
  coordinator: {
    gate: 'propose',
    models: {
      coordinator: { model: 'sonnet' },
      children: {
        XS: { model: 'sonnet' },
        S: { model: 'sonnet' },
        M: { model: 'opus', effort: 'high' },
        L: { model: 'opus' },
      },
    },
  },
}

describe('the model per role', () => {
  test('the coordinator has its own', () => {
    assert.deepEqual(agentFor(CONFIG, { role: 'coordinator' }, {}), { kind: 'claude', model: 'sonnet' })
  })

  test('a child’s comes from its Size', () => {
    assert.deepEqual(agentFor(CONFIG, { role: 'child', size: 'XS' }, {}), { kind: 'claude', model: 'sonnet' })
    assert.deepEqual(agentFor(CONFIG, { role: 'child', size: 'M' }, {}), {
      kind: 'claude',
      model: 'opus',
      effort: 'high',
    })
  })

  test('the command line wins over the configuration, field by field', () => {
    assert.deepEqual(agentFor(CONFIG, { role: 'child', size: 'M' }, { model: 'haiku' }), {
      kind: 'claude',
      model: 'haiku',
      effort: 'high',
    })
    assert.deepEqual(agentFor(CONFIG, { role: 'child', size: 'M' }, { kind: 'codex' }).kind, 'codex')
  })

  test('no Size, no entry, no configuration: the agent’s own default', () => {
    assert.deepEqual(agentFor(CONFIG, { role: 'child' }, {}), { kind: 'claude' })
    assert.deepEqual(agentFor(CONFIG, { role: 'child', size: 'XL' }, {}), { kind: 'claude' })
    assert.deepEqual(agentFor({}, { role: 'coordinator' }, {}), { kind: 'claude' })
  })

  test('a Size that does not exist is refused', () => {
    assert.throws(() => agentFor(CONFIG, { role: 'child', size: 'XXL' }, {}), /XS, S, M, L or XL/)
  })
})

describe('the gate', () => {
  test('propose unless the project says free', () => {
    assert.equal(gateOf({}), 'propose')
    assert.equal(gateOf(CONFIG), 'propose')
    assert.equal(gateOf({ coordinator: { gate: 'free' } }), 'free')
  })

  test('an answer approves only when it is the word', () => {
    for (const yes of ['approve', 'Approved.', 'yes!', 'OK', '  ok.\n', 'approved']) assert.ok(isApproval(yes), yes)
    for (const no of [
      'no',
      'not yet',
      'wait: #89 first',
      '',
      'okay but later',
      'yes, but not #84',
      'approve #89 only',
      'ok\nbut wait',
      'approved #89 only',
      'yes.!',
      'ok!!!',
      'ok .',
    ])
      assert.ok(!isApproval(no), no)
  })
})

describe('the approved issues', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lntt-approved-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('are written whole: no temporary file is left, and a hand-edited CRLF file is read', () => {
    approve(dir, 'alpha', [89])
    assert.deepEqual(readdirSync(dir), ['approved-alpha.txt'])
    writeFileSync(join(dir, 'approved-beta.txt'), '5\r\n6\r\n')
    assert.deepEqual([...approvals(dir, 'beta')], [5, 6])
  })

  test('a failed write leaves the list as it was and no temporary file', () => {
    approve(dir, 'alpha', [89])
    // The target cannot be replaced: renaming a file over a directory fails.
    mkdirSync(join(dir, 'approved-gamma.txt'))
    assert.throws(() => approve(dir, 'gamma', [1]))
    assert.deepEqual(readdirSync(dir).sort(), ['approved-alpha.txt', 'approved-gamma.txt'])
    assert.deepEqual([...approvals(dir, 'alpha')], [89])
  })

  test('a theme that is not a slug is refused', () => {
    assert.throws(() => approve(dir, '../x', [1]), /not a slug/)
  })

  test('skip lines that are not issue numbers', () => {
    writeFileSync(join(dir, 'approved-alpha.txt'), '89\n\n0\n-3\nabc\n111\n')
    assert.deepEqual([...approvals(dir, 'alpha')], [89, 111])
  })

  test('are kept per theme, in the shared mailbox directory', () => {
    assert.deepEqual([...approvals(dir, 'alpha')], [])
    approve(dir, 'alpha', [89, 111])
    approve(dir, 'alpha', [111, 117])
    approve(dir, 'beta', [5])
    assert.deepEqual(
      [...approvals(dir, 'alpha')].sort((a, b) => a - b),
      [89, 111, 117],
    )
    assert.deepEqual([...approvals(dir, 'beta')], [5])
  })
})

const VALUES = {
  theme: 'release-0-6-1',
  worktree: 'the worktree this session starts in',
  branch: 'chore/no-issue/release-0-6-1',
  issues: [
    { issue: 84, title: 'Coordinator mode' },
    { issue: 89, title: 'Board status' },
  ],
  approved: [89],
  config: CONFIG,
  orca: '/usr/local/bin/orca',
}

describe('the coordinator’s brief', () => {
  test('says it writes no code, lists the issues and names the placeholder branch', () => {
    const brief = coordinatorBrief(VALUES)
    assert.match(brief, /`release-0-6-1`\. You write no code/)
    assert.match(brief, /- #84: Coordinator mode/)
    assert.match(brief, /- #89: Board status/)
    assert.match(brief, /chore\/no-issue\/release-0-6-1/)
    assert.match(brief, /Never merge, never mark a pull request ready/)
    assert.doesNotMatch(brief, /\{\{/)
  })

  test('never carries the opt-in keyword of the harness’s multi-agent mode: the switch is --workflow', () => {
    assert.doesNotMatch(coordinatorBrief(VALUES), /ultracode/i)
    assert.match(coordinatorBrief(VALUES), /--workflow/)
  })

  test('calls orca by absolute path', () => {
    const brief = coordinatorBrief(VALUES)
    assert.match(brief, /\/usr\/local\/bin\/orca worktree set/)
    assert.doesNotMatch(brief, /(^|[^/\w])orca (worktree|terminal)/m)
  })

  test('on a host with no Orca there is no Orca line', () => {
    const brief = coordinatorBrief({ ...VALUES, orca: null })
    assert.doesNotMatch(brief, /orca/i)
  })

  test('under propose, names the approved children and the proposal flow', () => {
    const brief = coordinatorBrief(VALUES)
    assert.match(brief, /Approved to start now: #89/)
    assert.match(brief, /`lntt worktree start --theme` asks the orchestrator/)
    assert.match(brief, /#84/)
  })

  test('under free, no proposal', () => {
    const brief = coordinatorBrief({ ...VALUES, config: { coordinator: { gate: 'free' } }, approved: [] })
    assert.match(brief, /as soon as their order allows/)
    assert.doesNotMatch(brief, /asks the orchestrator to approve/)
  })

  test('says which model each role runs on', () => {
    const brief = coordinatorBrief(VALUES)
    assert.match(brief, /XS sonnet/)
    assert.match(brief, /M opus \(effort high\)/)
    assert.match(brief, /--size/)
  })
})

describe('the brief without a model or a gate', () => {
  test('says no model is configured, and that every child is proposed first', () => {
    const brief = coordinatorBrief({ ...VALUES, config: {}, approved: [] })
    assert.match(brief, /none is configured/)
    assert.match(brief, /No child is approved yet\. To propose first: #84, #89\./)
  })

  test('under free, and with only part of the models configured', () => {
    const free = coordinatorBrief({
      ...VALUES,
      config: { coordinator: { gate: 'free', models: { children: { S: { model: 'sonnet' } } } } },
    })
    assert.match(free, /as soon as their order allows/)
    assert.match(free, /you run on default; `--size` picks a child’s by the issue’s Size \(S sonnet\)/)
    const own = coordinatorBrief({
      ...VALUES,
      config: { coordinator: { models: { coordinator: { model: 'haiku' } } } },
    })
    assert.match(own, /you run on haiku;.*\(none configured\)/)
  })

  test('when every child is approved there is nothing to propose', () => {
    assert.match(coordinatorBrief({ ...VALUES, approved: [84, 89] }), /Nothing is left to propose/)
  })
})

describe('the child’s brief', () => {
  const base = { issue: 84, title: 'Coordinator mode', branch: 'feat/84/coordinator-mode', worktree: '/w' }

  test('without a theme it is the plain brief, byte for byte', () => {
    const plain = childBrief(base, {})
    assert.equal(
      plain,
      [
        'You are working on issue #84: Coordinator mode.',
        '',
        '- **The issue is the mandate.** Read it with `gh issue view 84` before anything',
        '  else; its Definition of Done is what finishes the work. `AGENTS.md` applies.',
        '- **Work only in this worktree:** `/w`, on branch `feat/84/coordinator-mode`. Run every',
        '  command from it, never from the main checkout or another worktree.',
        '- **Before publishing:** the review (`lntt review`, with the `review` skill) until a',
        '  round finds nothing, and `pnpm ci:local` green on the commit you push.',
        '- **Then open a draft pull request** with `Closes #84` and the Definition of Done',
        '  filled in, and **stop**: no merge, no `gh pr ready`. A person takes it from there.',
        '- **Return** a short summary of what changed, the pull request link, and any friction',
        '  met along the way (a missing tool, an unclear rule, a check that failed for reasons',
        '  outside the change).',
        '',
      ].join('\n'),
    )
    assert.doesNotMatch(plain, /theme|mailbox|workflow|ultracode/i)
    assert.doesNotMatch(plain, /\{\{/)
    assert.ok(plain.endsWith('outside the change).\n'))
  })

  test('with a context and a parent it carries the theme section and how to report', () => {
    const brief = childBrief(base, { theme: 'release-0-6-1', context: 'Your neighbours: #89 and #111.\n' })
    assert.match(brief, /## The theme\n\nYour neighbours: #89 and #111\./)
    assert.match(brief, /lntt ask --to coordinator --theme release-0-6-1/)
    assert.match(brief, /lntt inbox --as child --issue 84/)
    assert.doesNotMatch(brief, /\{\{/)
  })

  test('the workflow section is there only on request, and it limits the agents', () => {
    assert.doesNotMatch(childBrief(base, { theme: 't' }), /workflow/i)
    const brief = childBrief(base, { theme: 't', workflow: true })
    assert.match(brief, /ultracode/)
    assert.match(brief, /At most 6 agents/)
    assert.match(brief, /Never `isolation: 'worktree'`/)
    assert.match(brief, /\*\*one\*\* writing agent/)
  })

  test('on Orca the child keeps its card current, by absolute path', () => {
    const brief = childBrief(base, { theme: 't', orca: '/usr/local/bin/orca' })
    assert.match(brief, /\/usr\/local\/bin\/orca worktree set --worktree current --comment/)
  })
})
