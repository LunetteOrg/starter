import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import * as NodeFileSystem from '@effect/platform-node-shared/NodeFileSystem'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { SpawnerLive } from '../src/spawner.ts'
import { type Start, type Step, type Steps, startGit } from '../src/worktree/hosts.ts'
import { runSteps } from '../src/worktree/steps.ts'

// The adapters' steps on the machine, as `lntt worktree start` runs them (src/worktree/steps.ts):
// a real git and real processes. What each host is asked is src/worktree/hosts.spec.ts's.

const START: Start = {
  issue: 78,
  title: 'Start an agent',
  branch: 'feat/78/start-agent',
  base: 'main',
  agent: { kind: 'claude' },
  root: '/repo',
  brief: 'BRIEF',
}

// The steps run on the machine: their result, or the message of what failed.
const drive = <A>(steps: Steps<A>) =>
  Effect.runPromise(
    runSteps(steps).pipe(
      Effect.catchTag('ToolFailed', (error) => Effect.succeed(new Error(error.message))),
      Effect.provide(Layer.mergeAll(SpawnerLive, NodeFileSystem.layer)),
    ),
  )

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

  test("adds the worktree on the branch, runs its own orca.yaml's setup in it, leaves the agent to the person", async () => {
    // The main checkout's working copy is not what the new worktree checks out.
    writeFileSync(join(repo, 'orca.yaml'), 'scripts:\n  setup: |\n    echo uncommitted > setup-ran\n')
    const started = await drive(startGit({ ...START, root: repo, base: 'main' }))
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
  // One call to `node -e <code>`, as an adapter asks it.
  function* node(code: string): Steps<unknown> {
    return yield { kind: 'run', command: process.execPath, args: ['-e', code] } satisfies Step
  }

  test('stdout trimmed is the result', async () => {
    assert.equal(await drive(node("process.stdout.write('  out  '); process.stderr.write('note')")), 'out')
  })

  test('a refusal is reported in the error, with what the tool said', async () => {
    const json = await drive(
      node("process.stdout.write(JSON.stringify({ ok: false, error: { message: 'no such pane' } })); process.exit(2)"),
    )
    assert.match(String(json), /: no such pane$/)
    const said = await drive(node("process.stderr.write('error: branch has no upstream information'); process.exit(1)"))
    assert.match(String(said), /no upstream information$/)
    assert.match(String(await drive(node('process.exit(3)'))), /failed \(exit 3\)$/)
  })

  test('a tool that is not installed is an error, not an empty result', async () => {
    function* missing(): Steps<unknown> {
      return yield { kind: 'run', command: 'lntt-no-such-tool', args: [] } satisfies Step
    }
    assert.match(String(await drive(missing())), /lntt-no-such-tool could not start/)
  })
})
