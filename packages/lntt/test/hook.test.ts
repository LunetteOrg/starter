import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { FORMAT_HOOK, hookCommands, normalise, TYPECHECK_HOOK } from '../src/index.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = resolve(HERE, '../bin/lntt.ts')

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-hook-')))
  execFileSync('git', ['init', '-q'], { cwd: root })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function config(local: unknown): void {
  mkdirSync(join(root, '.agents'), { recursive: true })
  writeFileSync(join(root, '.agents/config.jsonc'), JSON.stringify({ local }))
}

function scripts(value: Record<string, string>): void {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: value }))
}

function hook(name: string, input = '') {
  return spawnSync(process.execPath, [BIN, 'hook', name], { cwd: root, input, encoding: 'utf8' })
}

describe('the commands a hook runs', () => {
  test('the key of .agents/config, one command or a list run in order', () => {
    config({ hooks: { typecheck: ['tsc --noEmit', 'mypy .'], format: 'biome format --write' } })
    assert.deepEqual(hookCommands(root, 'typecheck'), ['tsc --noEmit', 'mypy .'])
    assert.deepEqual(hookCommands(root, 'format'), ['biome format --write'])
  })

  test('the key wins over the script of the same name', () => {
    config({ hooks: { typecheck: 'tsc' } })
    scripts({ typecheck: 'other' })
    assert.deepEqual(hookCommands(root, 'typecheck'), ['tsc'])
  })

  test('without the key, the package.json script of that name, with the lockfile’s manager', () => {
    scripts({ typecheck: 'tsc', format: 'biome format --write' })
    assert.deepEqual(hookCommands(root, 'typecheck'), ['pnpm run typecheck'])
    writeFileSync(join(root, 'package-lock.json'), '{}')
    assert.deepEqual(hookCommands(root, 'format'), ['npm run format --'])
  })

  test('pnpm’s lockfile wins over npm’s', () => {
    scripts({ typecheck: 'tsc' })
    writeFileSync(join(root, 'package-lock.json'), '{}')
    writeFileSync(join(root, 'pnpm-lock.yaml'), '')
    assert.deepEqual(hookCommands(root, 'typecheck'), ['pnpm run typecheck'])
  })

  test('a package.json that is not JSON has no script', () => {
    writeFileSync(join(root, 'package.json'), '{ "scripts": ')
    assert.deepEqual(hookCommands(root, 'typecheck'), [])
  })

  test('without both, nothing', () => {
    config({})
    scripts({ test: 'node --test' })
    assert.deepEqual(hookCommands(root, 'typecheck'), [])
    rmSync(join(root, 'package.json'))
    rmSync(join(root, '.agents'), { recursive: true })
    assert.deepEqual(hookCommands(root, 'format'), [])
  })

  test('the schema takes a command or a non-empty list, and only these two hooks', () => {
    for (const hooks of [{ typecheck: [] }, { typecheck: '' }, { lint: 'x' }]) {
      config({ hooks })
      const r = spawnSync(process.execPath, [BIN, 'validate'], { cwd: root, encoding: 'utf8' })
      assert.equal(r.status, 1, JSON.stringify(hooks))
    }
    config({ hooks: { typecheck: ['tsc', 'mypy .'], format: 'biome format --write' } })
    assert.equal(spawnSync(process.execPath, [BIN, 'validate'], { cwd: root, encoding: 'utf8' }).status, 0)
  })
})

describe('lntt hook typecheck', () => {
  // The check fails while the file `red` holds text, printing it.
  const RED = 'if [ -s red ]; then cat red; exit 1; fi'
  const red = (text: string) => writeFileSync(join(root, 'red'), text)

  test('passes, and says nothing, when every command passes', () => {
    config({ hooks: { typecheck: ['true', 'true'] } })
    const r = hook('typecheck')
    assert.equal(r.status, 0)
    assert.equal(r.stdout + r.stderr, '')
  })

  test('with no command it does nothing and says nothing', () => {
    const r = hook('typecheck')
    assert.equal(r.status, 0)
    assert.equal(r.stdout + r.stderr, '')
  })

  test('a new failure exits 1 with the failing output; the same failure again stays quiet', () => {
    config({ hooks: { typecheck: RED } })
    red('src/a.ts(1,1): error TS2322\n')
    const first = hook('typecheck')
    assert.equal(first.status, 1)
    assert.match(first.stderr, /error TS2322/)
    const again = hook('typecheck')
    assert.equal(again.status, 0)
    assert.equal(again.stdout + again.stderr, '')
  })

  test('another failure wakes again', () => {
    config({ hooks: { typecheck: RED } })
    red('error TS2322\n')
    assert.equal(hook('typecheck').status, 1)
    red('error TS2345\n')
    const r = hook('typecheck')
    assert.equal(r.status, 1)
    assert.match(r.stderr, /TS2345/)
  })

  test('a green run clears it: the same failure later wakes again', () => {
    config({ hooks: { typecheck: RED } })
    red('error TS2322\n')
    assert.equal(hook('typecheck').status, 1)
    red('')
    assert.equal(hook('typecheck').status, 0)
    red('error TS2322\n')
    assert.equal(hook('typecheck').status, 1)
  })

  test('the failure is kept in the worktree’s git directory', () => {
    config({ hooks: { typecheck: RED } })
    red('error TS2322\n')
    hook('typecheck')
    assert.equal(existsSync(join(root, '.git/lntt-typecheck-failure')), true)
    red('')
    hook('typecheck')
    assert.equal(existsSync(join(root, '.git/lntt-typecheck-failure')), false)
  })

  test('output that differs only in colours, timings and trailing spaces is the same failure', () => {
    config({ hooks: { typecheck: RED } })
    red('\u001b[31merror\u001b[39m TS2322  \nDone in 1.2s\n')
    assert.equal(hook('typecheck').status, 1)
    red('error TS2322\nDone in 340ms\n')
    assert.equal(hook('typecheck').status, 0)
  })

  test('every command runs, and each failure is in the output with its command', () => {
    config({ hooks: { typecheck: ['echo ts broke; exit 1', 'true', 'echo py broke >&2; exit 1'] } })
    const r = hook('typecheck')
    assert.equal(r.status, 1)
    assert.match(r.stderr, /echo ts broke; exit 1[\s\S]*ts broke/)
    assert.match(r.stderr, /py broke/)
    assert.doesNotMatch(r.stderr, /^\$ true$/m)
  })

  test('the commands run from the project root', () => {
    config({ hooks: { typecheck: 'test -f .agents/config.jsonc' } })
    mkdirSync(join(root, 'sub'))
    assert.equal(
      spawnSync(process.execPath, [BIN, 'hook', 'typecheck'], { cwd: join(root, 'sub'), encoding: 'utf8' }).status,
      0,
    )
  })

  test('normalise strips colours, timings and trailing spaces, and leaves other numbers', () => {
    assert.equal(normalise('\u001b[2mx\u001b[22m  \nin 12.5s, 340ms\r\n'), 'x\nin s, s')
    assert.equal(normalise('expected 3 s, found 2 errors'), 'expected 3 s, found 2 errors')
  })

  test('a configuration lntt cannot read is a failure too, reported once', () => {
    config({ hooks: { typecheck: 'true' } })
    writeFileSync(join(root, '.agents/config.jsonc'), '{ "local": { "hooks": { "lint": "x" } } }')
    const first = hook('typecheck')
    assert.equal(first.status, 1)
    assert.match(first.stderr, /^lntt: .*config/m)
    assert.equal(hook('typecheck').status, 0)
  })

  test('outside git the last failure is kept in the temporary directory', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-hook-nogit-')))
    const tmp = join(outside, 'tmp')
    mkdirSync(tmp)
    mkdirSync(join(outside, '.agents'))
    writeFileSync(
      join(outside, '.agents/config.jsonc'),
      JSON.stringify({ local: { hooks: { typecheck: 'echo red; exit 1' } } }),
    )
    const run = () =>
      spawnSync(process.execPath, [BIN, 'hook', 'typecheck'], {
        cwd: outside,
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: tmp, GIT_CEILING_DIRECTORIES: dirname(outside) },
      })
    try {
      assert.equal(run().status, 1)
      assert.equal(run().status, 0)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('lntt hook format', () => {
  const input = (path: string) => JSON.stringify({ tool_input: { file_path: path }, tool_response: { filePath: path } })

  test('passes the written file to each command, quoted', () => {
    config({ hooks: { format: ['printf "%s\\n" >> one', 'printf "%s\\n" >> two'] } })
    const r = hook('format', input(join(root, 'a b.ts')))
    assert.equal(r.status, 0)
    assert.equal(readFileSync(join(root, 'one'), 'utf8'), `${join(root, 'a b.ts')}\n`)
    assert.equal(readFileSync(join(root, 'two'), 'utf8'), `${join(root, 'a b.ts')}\n`)
  })

  test('the path comes from tool_input when tool_response has none', () => {
    config({ hooks: { format: 'printf "%s" > got' } })
    hook('format', JSON.stringify({ tool_input: { file_path: '/x/y.ts' } }))
    assert.equal(readFileSync(join(root, 'got'), 'utf8'), '/x/y.ts')
  })

  test('a command that fails on the file is skipped: no error, no output, the next one runs', () => {
    config({ hooks: { format: ['echo nope; exit 1', 'printf "%s" > got'] } })
    const r = hook('format', input('/x/y.md'))
    assert.equal(r.status, 0)
    assert.equal(r.stdout + r.stderr, '')
    assert.equal(readFileSync(join(root, 'got'), 'utf8'), '/x/y.md')
  })

  test('the commands run from the project root, with a path holding a quote', () => {
    config({ hooks: { format: 'printf "%s" > got' } })
    mkdirSync(join(root, 'sub'))
    spawnSync(process.execPath, [BIN, 'hook', 'format'], {
      cwd: join(root, 'sub'),
      input: input("/x/it's.ts"),
      encoding: 'utf8',
    })
    assert.equal(readFileSync(join(root, 'got'), 'utf8'), "/x/it's.ts")
  })

  test('a configuration lntt cannot read is said once to the person, until it is fixed', () => {
    config({ hooks: { format: 'true' } })
    writeFileSync(join(root, '.agents/config.jsonc'), '{ "local": { "hooks": { "lint": "x" } } }')
    const first = hook('format', input('/x/y.ts'))
    assert.equal(first.status, 0)
    assert.match(
      JSON.parse(first.stdout).systemMessage,
      /^lntt hook format is off until this is fixed: lntt: [\s\S]*config\.jsonc/,
    )
    assert.equal(hook('format', input('/x/y.ts')).stdout, '')
    config({ hooks: { format: 'true' } })
    assert.equal(hook('format', input('/x/y.ts')).stdout, '')
    writeFileSync(join(root, '.agents/config.jsonc'), '{ "local": { "hooks": { "lint": "x" } } }')
    assert.match(hook('format', input('/x/y.ts')).stdout, /systemMessage/)
  })

  test('with no path, or input that is not JSON, nothing runs', () => {
    config({ hooks: { format: 'touch ran' } })
    for (const text of ['{}', 'not json', '']) {
      assert.equal(hook('format', text).status, 0)
      assert.equal(existsSync(join(root, 'ran')), false)
    }
  })

  test('the package.json script gets the path as its argument', () => {
    const bin = join(root, 'fake-bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\nprintf '%s|' "$@" > "${join(root, 'args')}"\n`)
    chmodSync(join(bin, 'pnpm'), 0o755)
    scripts({ format: 'biome format --write' })
    spawnSync(process.execPath, [BIN, 'hook', 'format'], {
      cwd: root,
      input: input('/x/y.ts'),
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    })
    assert.equal(readFileSync(join(root, 'args'), 'utf8'), 'run|format|/x/y.ts|')
  })
})

// The lines lntt sync writes run before anything checks lntt is there, or new enough.
describe('the hook lines of .claude/settings.json', () => {
  let tmp: string
  beforeEach(() => {
    tmp = join(root, 'tmp')
    mkdirSync(tmp)
  })

  // A fake lntt that exits as told.
  function lntt(status: number): void {
    mkdirSync(join(root, 'node_modules/.bin'), { recursive: true })
    writeFileSync(
      join(root, 'node_modules/.bin/lntt'),
      `#!/bin/sh\necho "$@" > "${join(root, 'lntt.args')}"\nexit ${status}\n`,
    )
    chmodSync(join(root, 'node_modules/.bin/lntt'), 0o755)
  }

  const run = (command: string) =>
    spawnSync('/bin/sh', ['-c', command], {
      cwd: tmpdir(),
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', CLAUDE_PROJECT_DIR: root, TMPDIR: tmp },
    })

  for (const [name, line] of [
    ['format', FORMAT_HOOK.command],
    ['typecheck', TYPECHECK_HOOK.command],
  ] as const) {
    test(`${name}: runs lntt hook ${name} from the project directory`, () => {
      lntt(0)
      const r = run(line)
      assert.equal(r.status, 0)
      assert.equal(r.stdout, '')
      assert.equal(readFileSync(join(root, 'lntt.args'), 'utf8').trim(), `hook ${name}`)
    })

    test(`${name}: with lntt missing it exits 0 and says nothing (the install hook said it)`, () => {
      const r = run(line)
      assert.equal(r.status, 0)
      assert.equal(r.stdout + r.stderr, '')
    })

    test(`${name}: an lntt with no hook command says once what to run, and exits 0`, () => {
      lntt(2)
      const first = run(line)
      assert.equal(first.status, 0)
      assert.match(JSON.parse(first.stdout).systemMessage, /lntt hook.*0\.6\.3.*pnpm up @lntt\/lntt/)
      const again = run(line)
      assert.equal(again.status, 0)
      assert.equal(again.stdout, '')
    })
  }

  test('typecheck: a new failure (lntt exits 1) wakes the agent (exit 2)', () => {
    lntt(1)
    assert.equal(run(TYPECHECK_HOOK.command).status, 2)
  })

  test('format: an lntt failure never fails the edit', () => {
    lntt(1)
    assert.equal(run(FORMAT_HOOK.command).status, 0)
  })

  test('an lntt with no hook command says it for each hook, once each', () => {
    lntt(2)
    assert.match(JSON.parse(run(FORMAT_HOOK.command).stdout).systemMessage, /pnpm up/)
    assert.match(JSON.parse(run(TYPECHECK_HOOK.command).stdout).systemMessage, /pnpm up/)
  })

  test('the typecheck runs in the background and wakes the agent', () => {
    assert.equal(TYPECHECK_HOOK.asyncRewake, true)
    assert.equal(TYPECHECK_HOOK.rewakeSummary, 'Typecheck failed')
  })
})

describe('lntt hook usage', () => {
  for (const args of [['hook', 'format', 'extra'], ['hook', 'lint'], ['hook']]) {
    test(`lntt ${args.join(' ')} is a usage error, exit 2`, () => {
      const r = spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', input: '' })
      assert.equal(r.status, 2)
      assert.match(r.stderr, /usage: lntt hook/)
    })
  }

  // What an lntt older than `hook` does with it, which the settings lines read as exit 2.
  test('a command lntt does not know is a usage error, exit 2', () => {
    const r = spawnSync(process.execPath, [BIN, 'frobnicate', 'typecheck'], { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 2)
  })
})
