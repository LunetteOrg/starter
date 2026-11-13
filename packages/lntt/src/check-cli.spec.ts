import { afterEach, assert, beforeEach, describe, it, vi } from '@effect/vitest'
import { parse } from './check-cli.ts'
import { Exit } from './exit.ts'

// What parse writes on stderr, and the code it exits with: null when it parsed.
let said = ''
beforeEach(() => {
  said = ''
  vi.spyOn(process.stderr, 'write').mockImplementation((text) => {
    said += String(text)
    return true
  })
})
afterEach(() => vi.restoreAllMocks())

async function exitOf(args: string[]): Promise<number | null> {
  try {
    await parse(args)
    return null
  } catch (error) {
    if (error instanceof Exit) return error.code
    if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')) return 2
    throw error
  }
}

describe('lntt check: usage errors, exit 2, before any configuration is read', () => {
  it('an unknown area or check, a file to a check that takes none, a base that looks like a flag', async () => {
    for (const [args, why] of [
      [['nope'], /no area nope/],
      [['decisions', 'nope'], /no check nope in decisions: structure, board-refs, numbers/],
      [['agents-md', 'AGENTS.md'], /no check AGENTS\.md in agents-md/],
      [['plugin', 'x'], /no check x in plugin/],
      [['--base='], /--base '' is not a ref/],
      [['--base=-x'], /--base -x is not a ref/],
      [['decisions', '--base=-x'], /--base -x is not a ref/],
      [['decisions', 'structure', 'docs/adr/storage.md'], /structure takes no file/],
      [['tests', 'focus', 'a.ts'], /focus takes no file/],
      [['decisions', 'numbers'], /numbers needs files or --base/],
      [['cite'], /give at least one path:line/],
      [['cite', 'src/app.ts'], /src\/app\.ts is not path:line/],
      [['cite', 'src/app.ts:1', '--base='], /--base '' is not a ref/],
    ] as [string[], RegExp][]) {
      assert.strictEqual(await exitOf(args), 2, args.join(' '))
      assert.match(said, why, args.join(' '))
      said = ''
    }
    assert.strictEqual(await exitOf(['--nope']), 2)
  })

  it('a mutation needs one path:line, --text, --to and at least one --test; those flags are for it only', async () => {
    const test = '--test=test/price.test.ts'
    for (const args of [
      ['src/price.ts', '--text=x', '--to=y', test],
      ['src/price.ts:7', '--text=x', test],
      ['--text=x', '--to=y', test],
      ['src/price.ts:7', '--text=', '--to=y', test],
      ['src/price.ts:7', '--text=x', '--to=y', '--test='],
      ['src/price.ts:7', '--text=x', '--to=y', '--test=-x'],
    ]) {
      assert.strictEqual(await exitOf(['tests', 'mutate', ...args]), 2, args.join(' '))
    }
    assert.strictEqual(
      await exitOf(['tests', 'mutate', 'src/price.ts:7', '--text=total > 100', '--to=total >= 100']),
      2,
    )
    assert.match(said, /mutate needs --test <test file>/)
    for (const flag of ['--text=x', '--to=y', test]) assert.strictEqual(await exitOf(['tests', 'focus', flag]), 2, flag)
  })

  it('--pr is for body, as a number, and not with - or template', async () => {
    for (const [args, why] of [
      [['decisions', '--pr=3'], /--pr is for body/],
      [['cite', 'a.ts:1', '--pr=3'], /--pr is for body/],
      [['body', '-', '--pr=3'], /give --pr <n> or -, not both/],
      [['body', 'template', '--pr=3'], /template reads the repository/],
      [['body', '--pr=03'], /--pr takes a number, not 03/],
    ] as [string[], RegExp][]) {
      assert.strictEqual(await exitOf(args), 2, args.join(' '))
      assert.match(said, why)
    }
  })
})

describe('lntt check: the command parsed', () => {
  it('alone, an area, a check with its files, cite, a mutation, the body of a pull request', async () => {
    const cwd = process.cwd()
    assert.deepStrictEqual(await parse([]), { kind: 'all', cwd, json: false })
    assert.deepStrictEqual(await parse(['decisions', 'board-refs', 'a.md', '--base', 'main', '--json']), {
      kind: 'area',
      area: 'decisions',
      check: 'board-refs',
      files: ['a.md'],
      cwd,
      json: true,
      base: 'main',
    })
    assert.deepStrictEqual(await parse(['cite', 'a.ts:1', '--query', '.message']), {
      kind: 'cite',
      anchors: ['a.ts:1'],
      cwd,
      json: false,
      query: '.message',
    })
    assert.deepStrictEqual(
      await parse(['tests', 'mutate', 'a.ts:3', '--text', 'x', '--to', 'y', '--test', 't1.ts', '--test', 't2.ts']),
      { kind: 'mutate', anchor: 'a.ts:3', text: 'x', to: 'y', tests: ['t1.ts', 't2.ts'], cwd, json: false },
    )
    assert.deepStrictEqual((await parse(['body', '--pr', '12'])) as unknown, {
      kind: 'area',
      area: 'body',
      files: [],
      body: { pr: 12 },
      cwd,
      json: false,
    })
    assert.deepStrictEqual((await parse(['body'])) as unknown, {
      kind: 'area',
      area: 'body',
      files: [],
      body: {},
      cwd,
      json: false,
    })
    assert.deepStrictEqual((await parse(['body', 'template'])) as unknown, {
      kind: 'area',
      area: 'body',
      check: 'template',
      files: [],
      cwd,
      json: false,
    })
  })
})
