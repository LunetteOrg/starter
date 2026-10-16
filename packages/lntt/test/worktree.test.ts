import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import {
  type Runner,
  renderBrief,
  type Start,
  setupScript,
  startGit,
  startHerdr,
  startOrca,
  worktreeHost,
} from '../src/index.ts'

describe('the host that creates the worktree', () => {
  test('Orca, Herdr, or plain git', () => {
    assert.equal(worktreeHost({ TERM_PROGRAM: 'Orca', ORCA_WORKTREE_ID: 'x' }), 'orca')
    assert.equal(worktreeHost({ HERDR_ENV: '1' }), 'herdr')
    assert.equal(worktreeHost({}), 'git')
  })

  test('hosts that cannot create worktrees fall back to git', () => {
    assert.equal(worktreeHost({ TERM_PROGRAM: 'waveterm' }), 'git')
    assert.equal(worktreeHost({ CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' }), 'git')
  })

  test('nested: Herdr running in an Orca terminal is the innermost, so Herdr creates it', () => {
    assert.equal(worktreeHost({ TERM_PROGRAM: 'Orca', ORCA_WORKTREE_ID: 'x', HERDR_ENV: '1' }), 'herdr')
  })
})

describe('the brief', () => {
  test('fills the issue, title, branch and worktree into the template', () => {
    const brief = renderBrief('#{{issue}} {{title}} on {{branch}} in {{worktree}}', {
      issue: 78,
      title: 'Start an agent',
      branch: 'feat/78/start-agent',
      worktree: '/w',
    })
    assert.equal(brief, '#78 Start an agent on feat/78/start-agent in /w')
  })

  test('the shipped template names the stop point and the friction return', () => {
    const brief = renderBrief(undefined, { issue: 78, title: 'T', branch: 'feat/78/t', worktree: '/w' })
    assert.match(brief, /#78/)
    assert.match(brief, /draft/)
    assert.match(brief, /no merge/i)
    assert.match(brief, /gh pr ready/)
    assert.match(brief, /friction/i)
    assert.match(brief, /\/w/)
    assert.doesNotMatch(brief, /\{\{/)
  })
})

// Records every call; answers from a table keyed by the command and its first arguments.
function recorder(answers: Record<string, string> = {}) {
  const calls: string[] = []
  const runner: Runner = {
    run(command, args) {
      const line = [command, ...args].join(' ')
      calls.push(line)
      const key = Object.keys(answers).find((k) => line.startsWith(k))
      return key ? (answers[key] as string) : ''
    },
    shell(script, cwd) {
      calls.push(`setup in ${cwd}: ${script.trim()}`)
    },
  }
  return { calls, runner }
}

const START: Start = {
  issue: 78,
  title: 'Start an agent',
  branch: 'feat/78/start-agent',
  base: 'main',
  agent: 'claude',
  root: '/repo',
  brief: 'BRIEF',
}

describe('Orca', () => {
  test('one create: the issue linked, setup run, the agent with the brief; the name flattened for rename', () => {
    const { calls, runner } = recorder({
      'orca worktree create': JSON.stringify({
        result: {
          worktree: {
            path: '/repo/.worktrees/starter/feat-78-start-agent',
            branch: 'refs/heads/me/feat-78-start-agent',
          },
          agentTerminalHandle: 'term_1',
        },
      }),
    })
    const started = startOrca(START, runner)
    assert.deepEqual(calls, [
      'orca worktree create --name feat-78-start-agent --issue 78 --base-branch main --setup run --json --agent claude --prompt BRIEF',
    ])
    assert.deepEqual(started, {
      host: 'orca',
      issue: 78,
      branch: 'feat/78/start-agent',
      path: '/repo/.worktrees/starter/feat-78-start-agent',
      agent: 'term_1',
    })
  })

  test('without an agent, no --agent and no --prompt', () => {
    const { calls, runner } = recorder({
      'orca worktree create': JSON.stringify({ result: { worktree: { path: '/p' } } }),
    })
    startOrca({ ...START, agent: null }, runner)
    assert.doesNotMatch(calls[0] as string, /--agent|--prompt/)
  })
})

describe('Herdr', () => {
  test('creates the worktree on the right name, runs the setup, starts the agent, sends the brief', () => {
    const { calls, runner } = recorder({
      'herdr worktree create': JSON.stringify({ result: { workspace: { root_pane: { pane_id: 'w2:p1' } } } }),
    })
    const started = startHerdr(START, runner, 'pnpm install --frozen-lockfile\n')
    const path = '/repo/.worktrees/feat-78-start-agent'
    assert.deepEqual(calls, [
      `herdr worktree create --branch feat/78/start-agent --base main --path ${path} --label feat-78-start-agent --no-focus`,
      `setup in ${path}: pnpm install --frozen-lockfile`,
      'herdr agent start feat-78-start-agent --kind claude --pane w2:p1',
      'herdr agent prompt feat-78-start-agent BRIEF',
    ])
    assert.equal(started.agent, 'feat-78-start-agent')
  })
})

describe('plain git', () => {
  let repo: string
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-worktree-')))
    git('init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'orca.yaml'), 'scripts:\n  setup: |\n    echo ready > setup-ran\n')
    git('add', '.')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init')
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  test('the setup is the one orca.yaml declares', () => {
    assert.equal(setupScript(repo)?.trim(), 'echo ready > setup-ran')
  })

  test('adds the worktree on the branch, runs the setup in it, leaves the agent to the person', () => {
    const real: Runner = {
      run: (command, args, opts) => execFileSync(command, args, { cwd: opts?.cwd ?? repo, encoding: 'utf8' }),
      shell: (script, cwd) => execFileSync('sh', ['-c', script], { cwd }),
    }
    const started = startGit({ ...START, root: repo }, real, setupScript(repo))
    const path = join(repo, '.worktrees', 'feat-78-start-agent')
    assert.deepEqual(started, { host: 'git', issue: 78, branch: 'feat/78/start-agent', path, agent: null })
    assert.equal(
      execFileSync('git', ['branch', '--show-current'], { cwd: path, encoding: 'utf8' }).trim(),
      'feat/78/start-agent',
    )
    assert.ok(existsSync(join(path, 'setup-ran')))
    assert.equal(readFileSync(join(path, 'setup-ran'), 'utf8').trim(), 'ready')
  })
})
