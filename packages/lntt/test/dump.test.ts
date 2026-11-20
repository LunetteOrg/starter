import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as Effect from 'effect/Effect'
import { runFailing } from '../src/dump/collect.ts'
import { SpawnerLive } from '../src/spawner.ts'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/lntt.ts')

const failing = (argv: string[], timeoutMs?: number) =>
  Effect.runPromise(runFailing(argv, tmpdir(), timeoutMs).pipe(Effect.provide(SpawnerLive)))

// The failing command on real processes: the spawner stops a command that hangs at the timeout,
// the shell's child included, and names the signal that killed one. The rest: src/dump/collect.spec.ts.
describe('runFailing', () => {
  test('a command that hangs is stopped at the timeout, and says so', async () => {
    for (const argv of [
      ['sleep', '10'],
      ['sh', '-c', 'sleep 10; true'],
    ]) {
      const started = Date.now()
      const run = await failing(argv, 1000)
      // Well under the command's own 10 s: the timeout stopped it, not its end.
      assert.ok(Date.now() - started < 8000, argv.join(' '))
      assert.equal(run.status, null)
      assert.equal(run.stopped, 'stopped after 1 s')
    }
    assert.equal((await failing(['sleep', '10'], 300)).stopped, 'stopped after 300 ms')
  })

  test('a command killed by a signal says which', async () => {
    const run = await failing(['sh', '-c', 'kill -TERM $$'])
    assert.equal(run.stopped, 'killed by SIGTERM')
  })
})

// The main paths of lntt dump through the CLI; what the dump says: src/dump.spec.ts, and what it
// gathers: src/dump/collect.spec.ts.
describe('lntt dump', () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-dump-cli-')))
    mkdirSync(join(root, '.agents'))
    writeFileSync(join(root, '.agents/config.jsonc'), '{}\n')
    writeFileSync(join(root, 'package.json'), '{"name":"app"}')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const lntt = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [BIN, 'dump', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: root, ...env },
    })

  test('runs the failing command after --, and redacts the home path and the secrets of the environment', () => {
    const run = lntt(['--model', 'm1', '--', 'sh', '-c', 'echo "in $HOME with $MY_TOKEN"; exit 3'], {
      MY_TOKEN: 'abcdefghijkl',
    })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /- model: m1/)
    assert.match(run.stdout, /- exit: 3/)
    assert.match(run.stdout, /in ~ with <redacted>/)
    assert.ok(!run.stdout.includes(root), 'the home path is gone')
  })

  test('a configuration that does not validate: the whole dump printed, then exit 1', () => {
    writeFileSync(join(root, '.agents/config.jsonc'), '{ "nope": 1 }\n')
    const run = lntt([])
    assert.equal(run.status, 1)
    assert.match(run.stdout, /### Project\n/)
    assert.match(run.stderr, /^lntt dump: .*does not match the schema/)
    const json = lntt(['--json'])
    assert.equal(json.status, 1)
    assert.match(JSON.parse(json.stdout).configError, /does not match the schema/)
  })

  test('no configuration file: the dump, exit 0', () => {
    rmSync(join(root, '.agents'), { recursive: true })
    const run = lntt([])
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /- configuration: no \.agents/)
  })

  test('--json gives the same dump as one object', () => {
    const run = lntt(['--json', '--harness', 'Codex 1.0'])
    assert.equal(run.status, 0, run.stderr)
    const dump = JSON.parse(run.stdout)
    assert.equal(dump.harness, 'Codex 1.0')
    assert.ok(Array.isArray(dump.sections))
  })

  test('a usage error exits 2: an unknown option, an option of lntt issue, a command without --, -- alone', () => {
    for (const args of [
      ['--nope'],
      ['--send'],
      ['--comment', '7'],
      ['--dump', 'x'],
      ['--repo', 'a/b'],
      ['--project', 'p'],
      ['ls'],
      ['--'],
    ]) {
      const run = lntt(args)
      assert.equal(run.status, 2, args.join(' '))
      assert.match(run.stderr, /usage: lntt dump/, args.join(' '))
    }
  })
})
