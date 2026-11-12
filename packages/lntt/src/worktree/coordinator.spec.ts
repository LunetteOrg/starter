import { readdirSync, readFileSync } from 'node:fs'
import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import { memoryFileSystem } from '../testing/file-system.ts'
import {
  agentFor,
  approvals,
  approve,
  type Config,
  childBrief,
  coordinatorBrief,
  gateOf,
  isApproval,
} from './coordinator.ts'
import type { Templates } from './hosts.ts'

// The templates lntt ships in agents/, as the command reads them.
const AGENTS = new URL('../../agents/', import.meta.url)
const T: Templates = Object.fromEntries(
  readdirSync(AGENTS)
    .filter((name) => name.endsWith('.md'))
    .map((name) => [name, readFileSync(new URL(name, AGENTS), 'utf8')]),
)

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
  it('the coordinator has its own', () => {
    assert.deepStrictEqual(agentFor(CONFIG, { role: 'coordinator' }, {}), { kind: 'claude', model: 'sonnet' })
  })

  it('a child’s comes from its Size', () => {
    assert.deepStrictEqual(agentFor(CONFIG, { role: 'child', size: 'XS' }, {}), { kind: 'claude', model: 'sonnet' })
    assert.deepStrictEqual(agentFor(CONFIG, { role: 'child', size: 'M' }, {}), {
      kind: 'claude',
      model: 'opus',
      effort: 'high',
    })
  })

  it('the command line wins over the configuration, field by field', () => {
    assert.deepStrictEqual(agentFor(CONFIG, { role: 'child', size: 'M' }, { model: 'haiku' }), {
      kind: 'claude',
      model: 'haiku',
      effort: 'high',
    })
    assert.deepStrictEqual(agentFor(CONFIG, { role: 'child', size: 'M' }, { kind: 'codex' }).kind, 'codex')
  })

  it('no Size, no entry, no configuration: the agent’s own default', () => {
    assert.deepStrictEqual(agentFor(CONFIG, { role: 'child' }, {}), { kind: 'claude' })
    assert.deepStrictEqual(agentFor(CONFIG, { role: 'child', size: 'XL' }, {}), { kind: 'claude' })
    assert.deepStrictEqual(agentFor({}, { role: 'coordinator' }, {}), { kind: 'claude' })
  })

  it('a Size that does not exist is refused', () => {
    assert.throws(() => agentFor(CONFIG, { role: 'child', size: 'XXL' }, {}), /XS, S, M, L or XL/)
  })
})

describe('the gate', () => {
  it('propose unless the project says free', () => {
    assert.strictEqual(gateOf({}), 'propose')
    assert.strictEqual(gateOf(CONFIG), 'propose')
    assert.strictEqual(gateOf({ coordinator: { gate: 'free' } }), 'free')
  })

  it('an answer approves only when it is the word', () => {
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
  const DIR = '/repo/.git/lntt-messages'
  const fs = () => memoryFileSystem({ dirs: ['/repo/.git'] })

  it.effect('are written whole: no temporary file is left, and a hand-edited CRLF file is read', () => {
    const files = fs()
    return Effect.gen(function* () {
      yield* approve(DIR, 'alpha', [89])
      assert.deepStrictEqual([...files.files.keys()], [`${DIR}/approved-alpha.txt`])
      yield* files.put(`${DIR}/approved-beta.txt`, '5\r\n6\r\n')
      assert.deepStrictEqual([...(yield* approvals(DIR, 'beta'))], [5, 6])
    }).pipe(Effect.provide(files.layer))
  })

  it.effect('a theme that is not a slug is refused', () =>
    Effect.gen(function* () {
      for (const theme of ['../x', 'a/b', 'a.b', 'A', '', 'a-', '-a', 'a--b']) {
        const error = yield* Effect.flip(approve(DIR, theme, [1]))
        assert.match(error.message, /not a slug/, theme)
      }
    }).pipe(Effect.provide(fs().layer)),
  )

  it.effect('skip lines that are not issue numbers', () => {
    const files = fs()
    return Effect.gen(function* () {
      yield* files.put(`${DIR}/approved-alpha.txt`, '89\n\n0\n-3\nabc\n111\n')
      assert.deepStrictEqual([...(yield* approvals(DIR, 'alpha'))], [89, 111])
    }).pipe(Effect.provide(files.layer))
  })

  it.effect('are kept per theme, in the shared mailbox directory', () =>
    Effect.gen(function* () {
      assert.deepStrictEqual([...(yield* approvals(DIR, 'alpha'))], [])
      yield* approve(DIR, 'alpha', [89, 111])
      yield* approve(DIR, 'alpha', [111, 117])
      yield* approve(DIR, 'beta', [5])
      assert.deepStrictEqual(
        [...(yield* approvals(DIR, 'alpha'))].sort((a, b) => a - b),
        [89, 111, 117],
      )
      assert.deepStrictEqual([...(yield* approvals(DIR, 'beta'))], [5])
    }).pipe(Effect.provide(fs().layer)),
  )
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
  it('says it writes no code, lists the issues and names the placeholder branch', () => {
    const brief = coordinatorBrief(T, VALUES)
    assert.match(brief, /`release-0-6-1`\. You write no code/)
    // One indent under their list item: a nested list, not a code block.
    assert.match(brief, /\n- \*\*The theme's issues:\*\*\n {2}- #84: Coordinator mode\n {2}- #89: Board status\n/)
    assert.match(brief, /chore\/no-issue\/release-0-6-1/)
    assert.match(brief, /Never merge, never mark a pull request ready/)
    assert.notMatch(brief, /\{\{/)
  })

  it('never carries the opt-in keyword of the harness’s multi-agent mode: the switch is --workflow', () => {
    assert.notMatch(coordinatorBrief(T, VALUES), /ultracode/i)
    assert.match(coordinatorBrief(T, VALUES), /--workflow/)
  })

  it('calls orca by absolute path', () => {
    const brief = coordinatorBrief(T, VALUES)
    assert.match(brief, /\/usr\/local\/bin\/orca worktree set/)
    assert.notMatch(brief, /(^|[^/\w])orca (worktree|terminal)/m)
  })

  it('says every wait goes through the mailbox, its own and its children’s', () => {
    const brief = coordinatorBrief(T, VALUES)
    assert.match(brief, /Every wait goes through the mailbox/)
    assert.match(brief, /1Password/)
    assert.match(brief, /review limit/)
    assert.match(brief, /`pnpm exec lntt inbox --as coordinator --theme release-0-6-1`/)
    assert.match(brief, /`pnpm exec lntt ask --to orchestrator`, batched, with a recommendation/)
    assert.match(brief, /re-reads its mailbox/)
    assert.match(brief, /`pnpm exec lntt ask --to child --issue <n>`/)
    assert.match(
      brief,
      /open decisions your children ask before their first\n {2}commit are collected and sent to the orchestrator in one batch, each with a\n {2}recommendation, before the children code\./,
    )
  })

  it('on a host with no Orca there is no Orca line', () => {
    const brief = coordinatorBrief(T, { ...VALUES, orca: null })
    assert.notMatch(brief, /orca/i)
  })

  it('under propose, names the approved children and the proposal flow', () => {
    const brief = coordinatorBrief(T, VALUES)
    assert.match(brief, /Approved to start now: #89/)
    assert.match(brief, /`pnpm exec lntt worktree start --theme` asks the orchestrator/)
    assert.match(brief, /#84/)
  })

  it('under free, no proposal', () => {
    const brief = coordinatorBrief(T, { ...VALUES, config: { coordinator: { gate: 'free' } }, approved: [] })
    assert.match(brief, /as soon as their order allows/)
    assert.notMatch(brief, /asks the orchestrator to approve/)
  })

  it('says which model each role runs on', () => {
    const brief = coordinatorBrief(T, VALUES)
    assert.match(brief, /XS sonnet/)
    assert.match(brief, /M opus \(effort high\)/)
    assert.match(brief, /--size/)
  })
})

describe('the brief without a model or a gate', () => {
  it('says no model is configured, and that every child is proposed first', () => {
    const brief = coordinatorBrief(T, { ...VALUES, config: {}, approved: [] })
    assert.match(brief, /none is configured/)
    assert.match(brief, /No child is approved yet\. To propose first: #84, #89\./)
  })

  it('under free, and with only part of the models configured', () => {
    const free = coordinatorBrief(T, {
      ...VALUES,
      config: { coordinator: { gate: 'free', models: { children: { S: { model: 'sonnet' } } } } },
    })
    assert.match(free, /as soon as their order allows/)
    assert.match(free, /you run on default; `--size` picks a child’s by the issue’s Size \(S sonnet\)/)
    const own = coordinatorBrief(T, {
      ...VALUES,
      config: { coordinator: { models: { coordinator: { model: 'haiku' } } } },
    })
    assert.match(own, /you run on haiku;.*\(none configured\)/)
  })

  it('when every child is approved there is nothing to propose', () => {
    assert.match(coordinatorBrief(T, { ...VALUES, approved: [84, 89] }), /Nothing is left to propose/)
  })
})

describe('the child’s brief', () => {
  const base = { issue: 84, title: 'Coordinator mode', branch: 'feat/84/coordinator-mode', worktree: '/w' }

  it('without a theme it is the plain brief, with its waits sent to the orchestrator, byte for byte', () => {
    const plain = childBrief(T, base, {})
    assert.strictEqual(
      plain,
      [
        'You are working on issue #84: Coordinator mode.',
        '',
        '- **The issue is the mandate.** Read it with `gh issue view 84` before anything',
        '  else; its Definition of Done is what finishes the work. `AGENTS.md` applies.',
        '- **Work only in this worktree:** `/w`, on branch `feat/84/coordinator-mode`. Run every',
        '  command from it, never from the main checkout or another worktree.',
        '- **Before publishing:** the review (`pnpm exec lntt review`, with the `review` skill) until a',
        "  round finds nothing, and `pnpm ci:local` green on the commit you push. The review's",
        '  state is read with `pnpm exec lntt review status`, never by opening files in the git',
        '  directory. At `lntt review: limit:` (`delivery.review.maxRounds`) stop: the round',
        '  sends what is still open to whoever you report to, who decides (below).',
        '- **Then open a draft pull request** with `Closes #84` and the Definition of Done',
        '  filled in, and **stop**: no merge, no `gh pr ready`. A person takes it from there.',
        '- **Return** a short summary of what changed, the pull request link, and any friction',
        '  met along the way (a missing tool, an unclear rule, a check that failed for reasons',
        '  outside the change).',
        '',
        '## Every wait goes through the mailbox',
        '',
        'Nobody watches your terminal: whatever you wait for, ask with `pnpm exec lntt ask --to orchestrator --issue 84 "<…>"`,',
        'which waits for the answer and prints it, never only in your tab. Run it in the',
        'background (or with `--timeout <s>`, then `pnpm exec lntt ask --wait <id>`), so that you re-read',
        'your mailbox between polls.',
        '',
        '- **An answer** the issue, the decision records and the code do not give.',
        '- **An approval:** a 1Password prompt for a `git push` or a secret, a go-ahead. Say what',
        '  it unlocks, and retry once it is answered.',
        '- **The review limit:** at `lntt review: limit:` the round sends the open findings',
        '  itself and prints the id of its message; wait for the answer with',
        '  `pnpm exec lntt ask --wait <id>`. An answer that grants rounds is the go: run',
        '  `pnpm exec lntt review allow <rounds>` yourself, then the next round. Past the last',
        '  allowed round a fix is made only inside a granted round: what is open stays listed as',
        '  open, and a commit waits until `lntt review allow` has granted the round that reviews it.',
        '',
        '## Open decisions come before the first commit',
        '',
        'Before your first commit, list the open decisions of your issue (what its body leaves',
        'to choose) and ask them in one `pnpm exec lntt ask --to orchestrator --issue 84 "<…>"`, each with a recommendation and the',
        'criteria that decide it. Start coding once it is answered.',
        '',
        'A decision that arrives after your review converged, and would change the change, is',
        'asked the same way: apply it in this pull request, or in a follow-up. Applied here, the',
        "new rounds need the person's go: a round does not restart on its own, and past",
        '`delivery.review.maxRounds` the go is `pnpm exec lntt review allow <rounds>` (above).',
        '',
        'While you wait, and before you resume after any pause, re-read your mailbox:',
        '`pnpm exec lntt inbox --as child --issue 84`. A decision sent there holds over what you',
        'assumed.',
        '',
      ].join('\n'),
    )
    assert.notMatch(plain, /theme|workflow|ultracode/i)
    assert.notMatch(plain, /\{\{/)
  })

  it('a child of a theme routes every wait to its coordinator, and re-reads its mailbox', () => {
    const brief = childBrief(T, base, { theme: 'release-0-6-1' })
    assert.match(brief, /## Every wait goes through the mailbox/)
    assert.match(brief, /ask with `pnpm exec lntt ask --to coordinator --theme release-0-6-1 --issue 84 "<…>"`/)
    assert.notMatch(brief, /--to orchestrator/)
    assert.match(brief, /1Password/)
    assert.match(brief, /at `lntt review: limit:` the round sends the open findings/)
    assert.match(brief, /`pnpm exec lntt ask --wait <id>`/)
    assert.match(brief, /re-read your mailbox:\n`pnpm exec lntt inbox --as child --issue 84`/)
    assert.match(brief, /## Open decisions come before the first commit/)
    assert.match(brief, /ask them in one `pnpm exec lntt ask --to coordinator --theme release-0-6-1 --issue 84 "<…>"`/)
    assert.match(
      brief,
      /new rounds need the person's go: a round does not restart on its own, and past\n`delivery\.review\.maxRounds` the go is `pnpm exec lntt review allow <rounds>`/,
    )
    assert.notMatch(brief, /workflow|orca/i)
  })

  it('a child of a theme with no coordinator reports and waits to the orchestrator, with the theme’s context', () => {
    const brief = childBrief(T, base, {
      theme: 'standalone',
      coordinator: false,
      context: 'Touch only the brief.',
      orca: '/usr/local/bin/orca',
    })
    assert.match(brief, /## You are a child of the theme `standalone`/)
    assert.match(brief, /## The theme\n\nTouch only the brief\./)
    assert.match(brief, /`pnpm exec lntt ask --to orchestrator --issue 84 "<question>"`/)
    assert.match(brief, /`pnpm exec lntt ask --to orchestrator --issue 84 "#84 ready: /)
    assert.match(brief, /lntt inbox --as child --issue 84/)
    assert.match(brief, /the orchestrator reads it/)
    assert.notMatch(brief, /--to coordinator|your coordinator|the coordinator/i)
    assert.notMatch(brief, /\{\{/)
  })

  it('explicitly coordinated is the default: the coordinator is asked', () => {
    const brief = childBrief(T, base, { theme: 't', coordinator: true })
    assert.strictEqual(brief, childBrief(T, base, { theme: 't' }))
    assert.match(brief, /--to coordinator --theme t --issue 84/)
  })

  it('with a context and a parent it carries the theme section and how to report', () => {
    const brief = childBrief(T, base, { theme: 'release-0-6-1', context: 'Your neighbours: #89 and #111.\n' })
    assert.match(brief, /## The theme\n\nYour neighbours: #89 and #111\./)
    assert.match(brief, /`pnpm exec lntt ask --to coordinator --theme release-0-6-1 --issue 84 "<question>"`/)
    assert.match(brief, /`pnpm exec lntt ask --to coordinator --theme release-0-6-1 --issue 84 "#84 ready: /)
    assert.match(brief, /lntt inbox --as child --issue 84/)
    assert.notMatch(brief, /\{\{/)
  })

  it('the workflow section is there only on request, and it limits the agents', () => {
    assert.notMatch(childBrief(T, base, { theme: 't' }), /workflow/i)
    const brief = childBrief(T, base, { theme: 't', workflow: true })
    assert.match(brief, /ultracode/)
    assert.match(brief, /At most 6 agents/)
    assert.match(brief, /Never `isolation: 'worktree'`/)
    assert.match(brief, /\*\*one\*\* writing agent/)
  })

  it('on Orca the child keeps its card current, by absolute path', () => {
    const brief = childBrief(T, base, { theme: 't', orca: '/usr/local/bin/orca' })
    assert.match(brief, /\/usr\/local\/bin\/orca worktree set --worktree current --comment/)
  })
})
