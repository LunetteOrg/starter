import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import {
  collect,
  drawn,
  FEDERATION,
  federationMissing,
  flagsOf,
  helpFlags,
  missingFlags,
  ownArgs,
  recorder,
  upstream,
  waitFor,
} from './upstream.ts'

// The helpers of the upstream tests, without the real tools: every upstream test skips
// on a machine without them, so a helper that always says yes would go unseen.
describe('upstream helpers', () => {
  const smoke = process.env.UPSTREAM_SMOKE
  afterEach(() => {
    if (smoke === undefined) delete process.env.UPSTREAM_SMOKE
    else process.env.UPSTREAM_SMOKE = smoke
  })

  test('UPSTREAM_SMOKE names the tools to check, comma-separated', () => {
    process.env.UPSTREAM_SMOKE = 'orca, herdr'
    assert.equal(upstream('orca'), true)
    assert.equal(upstream('herdr'), true)
    assert.equal(upstream('claude'), false)
    process.env.UPSTREAM_SMOKE = ''
    assert.equal(upstream('orca'), false)
    delete process.env.UPSTREAM_SMOKE
    assert.equal(upstream('opencode'), false)
  })

  test('the recorder answers with the longest key a call starts with', () => {
    const { calls, runner } = recorder({
      'orca worktree create': '{"result":{}}',
      'orca worktree create --help': 'Usage: orca worktree create --name',
    })
    assert.equal(runner.run('orca', ['worktree', 'create', '--help']), 'Usage: orca worktree create --name')
    assert.equal(runner.run('orca', ['worktree', 'create', '--json']), '{"result":{}}')
    assert.equal(runner.run('orca', ['terminal', 'send']), '')
    assert.equal(calls.length, 3)
  })

  test('flagsOf keeps the flags of an argument list, not their values', () => {
    assert.deepEqual(flagsOf(['-p', '--model', 'haiku', 'a-prompt', '-s', 'ses_1']), ['-p', '--model', '-s'])
  })

  test("helpFlags reads the option lines, not a flag another option's description names", () => {
    const help = [
      'Usage: tool [options]',
      '',
      'Options:',
      '  -c, --continue                        Continue; with --resume <id>, that',
      '                                        --resume <id> picks the session',
      '  --model <model>                       The model',
      '      --no-focus',
      '          Keep the focus',
    ].join('\n')
    const flags = helpFlags(help)
    assert.deepEqual([...flags].sort(), ['--continue', '--model', '--no-focus', '-c'])
    assert.equal(flags.has('--resume'), false)
  })

  test('missingFlags names each flag the description lacks, by subcommand', () => {
    const used = new Map<string, Set<string>>()
    collect(used, 'worktree create', ['--name', '--model'])
    collect(used, 'worktree create', ['--effort'])
    collect(used, 'terminal send', ['--text'])
    const known = (subcommand: string) => new Set(subcommand === 'worktree create' ? ['--name', '--model'] : ['--text'])
    assert.deepEqual(missingFlags('orca', used, known), ['orca worktree create: --effort not in its description'])
    assert.deepEqual(missingFlags('orca', new Map([['terminal send', new Set(['--text'])]]), known), [])
  })

  test("drawn: the brief is on the agent's screen once its interface replaced the shell", () => {
    const brief = 'You are working on issue #1'
    assert.equal(drawn(`$ OPENCODE_CONFIG_CONTENT='{}' opencode --standalone\n${brief}`, brief), false)
    assert.equal(drawn(`opencode\n> ${brief}`, brief), true)
    assert.equal(drawn('opencode\n> ', brief), false)
  })

  test('missingFlags tells a description it reads no flag from apart from a removed flag', () => {
    const used = new Map([['agent start', new Set(['--kind'])]])
    assert.deepEqual(
      missingFlags('herdr', used, () => new Set()),
      ['herdr agent start: its description lists no flag; the format may have changed'],
    )
  })

  test("ownArgs leaves out the agent's arguments after --", () => {
    assert.deepEqual(ownArgs(['agent', 'start', 'x', '--kind', 'claude', '--', '--model', 'sonnet']), [
      'agent',
      'start',
      'x',
      '--kind',
      'claude',
    ])
    assert.deepEqual(ownArgs(['pane', 'run', 'p1', 'opencode']), ['pane', 'run', 'p1', 'opencode'])
    assert.deepEqual(ownArgs(['--', 'x']), [])
    assert.deepEqual(ownArgs(['a', '--', 'b', '--', 'c']), ['a'])
  })

  test('waitFor returns the first value its probe gives, and times out naming what it waited for', async () => {
    let tries = 0
    assert.equal(await waitFor('a second try', () => ++tries >= 2 && 'ready', 5_000), 'ready')
    await assert.rejects(
      waitFor(
        'nothing',
        () => false,
        50,
        () => 'the screen',
      ),
      /timed out after 50 ms waiting for nothing\nthe screen/,
    )
  })

  test("claude's reply check runs only with every federation variable and the token file", () => {
    const all = Object.fromEntries(FEDERATION.map((name) => [name, 'x']))
    assert.deepEqual(federationMissing(all), [])
    for (const name of FEDERATION) {
      assert.deepEqual(federationMissing({ ...all, [name]: '' }), [name])
    }
    assert.deepEqual(federationMissing({}), [...FEDERATION])
  })
})
