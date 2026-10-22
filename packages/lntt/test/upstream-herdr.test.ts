import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { type Start, setupScript, startHerdr } from '../src/worktree.ts'
import { runner } from '../src/worktree-cli.ts'
import {
  background,
  collect,
  drawn,
  flagsOf,
  helpFlags,
  missingFlags,
  ownArgs,
  recorder,
  throwawayHome,
  tool,
  upstream,
  useHome,
  waitFor,
} from './upstream.ts'

// lntt's Herdr adapter against the real Herdr: its flags against each subcommand's
// --help, then startHerdr on a headless Herdr server, with the real claude not logged in
// (Herdr detects it as a ready agent at its welcome screen) and opencode on its free
// model for the shell-command route.
const skip = upstream('herdr')
  ? false
  : 'set UPSTREAM_SMOKE=herdr to run (needs the real Herdr, headless, on a throwaway machine)'

const START: Start = {
  issue: 137,
  title: 'Upstream check',
  branch: 'feat/137/upstream-herdr',
  base: 'main',
  agent: { kind: 'claude', model: 'sonnet', effort: 'medium' },
  root: '/repo',
  brief: 'BRIEF',
}

const OPENCODE = { kind: 'opencode', model: process.env.UPSTREAM_OPENCODE_MODEL ?? 'opencode/deepseek-v4.1-flash-free' }

describe('Herdr flags', () => {
  test("every flag lntt passes to herdr is in that subcommand's --help", { skip }, () => {
    // Both routes: `agent start` with the agent's arguments after `--`, and the shell
    // command Herdr detects; a create reply with no pane, so `pane list` runs too.
    const { calls, runner: recording } = recorder({
      'herdr worktree create': JSON.stringify({ result: { workspace: { workspace_id: 'w1' } } }),
      'herdr pane list': JSON.stringify({ result: { panes: [{ pane_id: 'p1' }] } }),
      'herdr agent list': JSON.stringify({ result: { agents: [{ pane_id: 'p1' }] } }),
    })
    startHerdr(START, recording, () => null)
    startHerdr({ ...START, agent: OPENCODE }, recording, () => null)
    const used = new Map<string, Set<string>>()
    for (const [command, ...args] of calls) {
      if (command !== 'herdr') continue
      const own = ownArgs(args)
      collect(used, own.slice(0, 2).join(' '), flagsOf(own))
    }
    assert.ok(used.has('agent start') && used.has('pane run'), 'both routes ran')
    const flags = (subcommand: string) => helpFlags(tool('herdr', [...subcommand.split(' '), '--help']))
    assert.deepEqual(missingFlags('herdr', used, flags), [])
  })
})

describe('Herdr headless', () => {
  let home = ''
  let repo = ''
  let stop = () => {}
  const cwd = process.cwd()
  let restore = () => {}

  // herdr and lntt's runner reach the server through its socket under HOME.
  before(async () => {
    if (skip) return
    ;({ home, repo } = throwawayHome())
    restore = useHome(home)
    process.chdir(repo)
    stop = background('herdr', ['server'], join(home, 'server.log'))
    await waitFor('herdr server to answer', () => tool('herdr', ['agent', 'list']).includes('agent_list'))
  })

  after(() => {
    if (skip) return
    try {
      tool('herdr', ['server', 'stop'])
    } catch {}
    stop()
    process.chdir(cwd)
    restore()
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 3 })
    } catch {}
  })

  interface Listed {
    name?: string
    agent?: string
    pane_id?: string
    workspace_id?: string
    cwd?: string
  }
  const agents = () => (JSON.parse(tool('herdr', ['agent', 'list'])) as { result: { agents: Listed[] } }).result.agents
  const screen = (pane: string) => tool('herdr', ['pane', 'read', pane])
  const worktrees = () => tool('git', ['worktree', 'list', '--porcelain'], { cwd: repo })

  test('startHerdr, claude with model and effort: agent start in the new pane, the brief prompted', {
    skip,
    timeout: 180_000,
  }, () => {
    const started = startHerdr(
      { ...START, root: repo, brief: 'lntt upstream check: Herdr starts the agent' },
      runner,
      setupScript,
    )
    assert.ok(started.path && existsSync(started.path), `the worktree exists: ${started.path}`)
    assert.ok(worktrees().includes(`worktree ${started.path}\n`), 'git lists the worktree')
    assert.equal(started.agent, 'feat-137-upstream-herdr')
    const listed = agents().find((a) => a.name === started.agent)
    assert.ok(listed, `herdr agent list has ${started.agent}`)
    assert.equal(listed.agent, 'claude')
    assert.match(listed.pane_id ?? '', /\S/)
    assert.match(listed.workspace_id ?? '', /\S/)
    assert.equal(listed.cwd, started.path)
    // The model and effort after `--` reached claude's command line; `agent prompt`
    // succeeded, or startHerdr threw (claude, not logged in, shows no prompt).
    assert.match(screen(listed.pane_id as string), /claude --model sonnet --effort medium/)
  })

  test('startHerdr, opencode with a model: the shell command, detected, the brief prompted', {
    skip,
    timeout: 180_000,
  }, async () => {
    const brief = 'Reply with the single word ok.'
    const started = startHerdr(
      { ...START, branch: 'feat/137/upstream-herdr-shell', root: repo, brief, agent: OPENCODE },
      runner,
      setupScript,
    )
    assert.ok(started.path && existsSync(started.path), `the worktree exists: ${started.path}`)
    assert.ok(worktrees().includes(`worktree ${started.path}\n`), 'git lists the worktree')
    const listed = agents().find((a) => a.pane_id === started.agent)
    assert.ok(listed, `herdr agent list has an agent in ${started.agent}`)
    assert.equal(listed.agent, 'opencode')
    // The brief is on opencode's own screen, not lost to an interface still starting:
    // text typed before the interface draws shows next to the shell command, then goes.
    const pane = started.agent as string
    await waitFor(
      'the brief on the opencode screen',
      () => drawn(screen(pane), brief),
      30_000,
      () => screen(pane),
    )
  })
})
