import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { type Runner, runTool, type Start, setupScript, startGit } from '../src/worktree.ts'

const START: Start = {
  issue: 78,
  title: 'Start an agent',
  branch: 'feat/78/start-agent',
  base: 'main',
  agent: { kind: 'claude' },
  root: '/repo',
  brief: 'BRIEF',
}

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
    // The main checkout's working copy is not what the new worktree checks out.
    writeFileSync(join(repo, 'orca.yaml'), 'scripts:\n  setup: |\n    echo uncommitted > setup-ran\n')
    const real: Runner = {
      run: (command, args, opts) => execFileSync(command, args, { cwd: opts?.cwd ?? repo, encoding: 'utf8' }),
      shell: (script, cwd) => execFileSync('sh', ['-c', script], { cwd }),
      sleep: () => {},
    }
    const started = startGit({ ...START, root: repo, base: 'main' }, real, setupScript)
    const path = join(repo, '.worktrees', 'feat-78-start-agent')
    assert.deepEqual(started, { host: 'git', issue: 78, branch: 'feat/78/start-agent', path, agent: null })
    assert.equal(
      execFileSync('git', ['branch', '--show-current'], { cwd: path, encoding: 'utf8' }).trim(),
      'feat/78/start-agent',
    )
    assert.ok(existsSync(join(path, 'setup-ran')))
    assert.equal(readFileSync(join(path, 'setup-ran'), 'utf8').trim(), 'ready', "the new worktree's own orca.yaml")
    const upstream = spawnSync('git', ['rev-parse', '--abbrev-ref', '@{upstream}'], { cwd: path, encoding: 'utf8' })
    assert.notEqual(upstream.status, 0, `no upstream for a new branch, got ${upstream.stdout}`)
  })
})

describe('running a tool', () => {
  const node = (code: string) => [process.execPath, ['-e', code]] as const

  test('stdout trimmed is the result; what the tool says on stderr reaches the person', () => {
    const said: string[] = []
    const [cmd, args] = node("process.stdout.write('  out  '); process.stderr.write('note')")
    assert.equal(
      runTool(cmd, [...args], process.cwd(), (t) => said.push(t)),
      'out',
    )
    assert.deepEqual(said, ['note'])
  })

  test('a refusal is reported once, in the error, with what the tool said', () => {
    const said: string[] = []
    const [a, aa] = node(
      "process.stdout.write(JSON.stringify({ ok: false, error: { message: 'no such pane' } })); process.exit(2)",
    )
    assert.throws(() => runTool(a, [...aa], process.cwd(), (t) => said.push(t)), /: no such pane$/)
    const [b, bb] = node("process.stderr.write('error: branch has no upstream information'); process.exit(1)")
    assert.throws(() => runTool(b, [...bb], process.cwd(), (t) => said.push(t)), /no upstream information$/)
    assert.deepEqual(said, [], 'nothing reaches the person besides the error, which a caller may expect and drop')
    const [d, dd] = node('process.exit(3)')
    assert.throws(() => runTool(d, [...dd], process.cwd(), () => {}), /failed \(exit 3\)$/)
  })

  test('a tool that is not installed is an error, not an empty result', () => {
    assert.throws(() => runTool('lntt-no-such-tool', [], process.cwd()), /ENOENT/)
  })
})
