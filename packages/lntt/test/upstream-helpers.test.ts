import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { collect, drawn, flagsOf, helpFlags, missingFlags, recorder, upstream } from './upstream.ts'

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
})
