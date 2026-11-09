import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { cli, type Project, project } from './cli-project.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '../src')
const EXIT = join(SRC, 'exit.ts')
const BIN = resolve(HERE, '../bin/lntt.ts')

// More than any pipe's buffer (64 KB on Linux and macOS), so that a process that ends before
// the reader took the rest leaves the document cut.
const LONG = 500_000

// Every TypeScript module of src but the tests, by its path from src.
function modules(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return modules(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [relative(SRC, path)] : []
  })
}

describe('the one exit path of lntt', () => {
  // The whole text of each file, so that an import over several lines is read whole.
  const ENDS = [
    /\bprocess\s*\.\s*(?:exit|reallyExit|abort)\s*\(/g,
    /import\s+(?:\w+\s*,\s*)?\{[^}]*\bexit\b[^}]*\}\s*from\s*['"](?:node:)?process['"]/g,
  ]
  const ends = (path: string): string[] => {
    const text = readFileSync(path, 'utf8')
    return ENDS.flatMap((re) =>
      [...text.matchAll(re)].map((m) => `${text.slice(0, m.index).split('\n').length}: ${m[0].replace(/\s+/g, ' ')}`),
    )
  }

  test('no module of src or bin ends the process but src/exit.ts', () => {
    const files = [...modules().map((m) => join(SRC, m)), BIN].filter((f) => f !== EXIT)
    const found = files.flatMap((f) => ends(f).map((at) => `${relative(dirname(SRC), f)}:${at}`))
    assert.deepEqual(found, [], 'every exit goes through src/exit.ts, which lets stdout drain first')
  })

  test('the scan sees each form an exit takes', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-exit-scan-')))
    try {
      const forms = [
        "import { cwd, exit } from 'node:process'",
        "import process, { exit, stderr } from 'node:process'",
        "import {\n  cwd,\n  exit,\n} from 'node:process'",
        'process.exit(1)',
        'process\n  .exit(1)',
      ]
      for (const [i, form] of forms.entries()) {
        writeFileSync(join(dir, `${i}.ts`), `${form}\n`)
        assert.equal(ends(join(dir, `${i}.ts`)).length, 1, form)
      }
      writeFileSync(join(dir, 'none.ts'), "import { exitCode, stderr } from 'node:process'\nprocess.exitCode = 1\n")
      assert.deepEqual(ends(join(dir, 'none.ts')), [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('a process that writes more than a pipe takes', () => {
    let dir: string
    beforeEach(() => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-exit-')))
    })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    // A script of its own, run through a pipe on both stdout and stderr.
    const script = (body: string) => {
      const path = join(dir, 'script.ts')
      writeFileSync(
        path,
        `import { exit, finish, leave } from ${JSON.stringify(EXIT)}\nvoid [exit, finish, leave]\n${body}\n`,
      )
      return spawnSync(process.execPath, [path], { encoding: 'utf8', maxBuffer: 1e8, timeout: 30_000 })
    }

    test('an exit from inside a command: both streams whole, then its code', () => {
      const r = script(`await finish(() => {
  process.stdout.write('o'.repeat(${LONG}))
  process.stderr.write('e'.repeat(${LONG}))
  exit(3)
})`)
      assert.deepEqual([r.status, r.stdout.length, r.stderr.length], [3, LONG, LONG])
    })

    test('a command that returns: its exitCode, 0 when it set none', () => {
      const set = script(`await finish(() => { process.stdout.write('o'.repeat(${LONG})); process.exitCode = 1 })`)
      assert.deepEqual([set.status, set.stdout.length], [1, LONG])
      const none = script(`await finish(async () => { process.stdout.write('o'.repeat(${LONG})) })`)
      assert.deepEqual([none.status, none.stdout.length], [0, LONG])
    })

    test('a defect: its stack on stderr after what was written, exit 1', () => {
      const r = script(
        `await finish(() => { process.stdout.write('o'.repeat(${LONG})); throw new Error('the defect') })`,
      )
      assert.equal(r.status, 1)
      assert.equal(r.stdout.length, LONG)
      assert.match(r.stderr, /Error: the defect\n\s+at /)
    })

    test('an exit from a signal handler or a timer, which cannot throw to the command: whole', () => {
      // The interval would keep the process alive: only the exit ends it.
      const r = script(`setInterval(() => {}, 1000)
process.on('SIGUSR2', () => { process.stdout.write('o'.repeat(${LONG})); void leave(130) })
setTimeout(() => process.kill(process.pid, 'SIGUSR2'), 10)`)
      assert.deepEqual([r.status, r.stdout.length], [130, LONG])
    })

    test('a reader of stderr that left does not turn the exit into a crash', () => {
      const path = join(dir, 'script.ts')
      writeFileSync(
        path,
        `import { exit, finish } from ${JSON.stringify(EXIT)}\nawait finish(() => { process.stderr.write('e'.repeat(${LONG})); exit(3) })\n`,
      )
      // pipefail: the exit code of lntt, not of head.
      const shell = `set -o pipefail; '${process.execPath}' '${path}' 2>&1 >/dev/null | head -c 1 >/dev/null; echo "code $?"`
      const r = spawnSync('bash', ['-c', shell], { encoding: 'utf8' })
      // 3, the command's: a crash on the closed pipe would exit 1.
      assert.equal(r.stdout, 'code 3\n', r.stderr)
    })

    test('a reader that left does not turn the exit into a crash', () => {
      const path = join(dir, 'script.ts')
      writeFileSync(
        path,
        `import { exit, finish } from ${JSON.stringify(EXIT)}\nawait finish(() => { process.stdout.write('o'.repeat(${LONG})); exit(1) })\n`,
      )
      const r = spawnSync(
        'sh',
        ['-c', `{ '${process.execPath}' '${path}'; echo "code $?" >&2; } | head -c 1 >/dev/null`],
        {
          encoding: 'utf8',
        },
      )
      assert.equal(r.stderr, 'code 1\n')
    })
  })
})

// A usage error of each command whose catch-all wraps its arguments' check: the exit goes
// through that catch, which lets it pass, so the usage is printed alone, exit 2.
describe('a usage error passes the catch-all of its command', () => {
  let p: Project
  beforeEach(() => {
    p = project()
  })
  afterEach(() => p.remove())

  for (const args of [
    ['board', 'sync', '--bogus'],
    ['board', 'ready', '--bogus'],
    ['branch', 'name', '--issue', 'x'],
    ['refs', '--bogus'],
    ['ask', '--bogus'],
    ['worktree', 'start'],
    ['ci', 'proved'],
    ['dump', 'stray'],
    ['check', 'nope'],
    ['browser', '--bogus'],
    ['review', 'allow', 'x'],
    ['retro', 'add'],
  ]) {
    test(args.join(' '), () => {
      const r = cli(p, args)
      assert.equal(r.status, 2, r.stderr)
      assert.match(r.stderr, /usage: /)
      assert.doesNotMatch(r.stderr, /lntt exits|Exit/)
    })
  }
})

// Each command that takes --json, run through a pipe on a document longer than a pipe's
// buffer: what arrives parses.
describe('every --json command through a pipe', () => {
  let p: Project
  beforeEach(() => {
    p = project({ long: LONG })
  })
  afterEach(() => p.remove())

  for (const [name, args, read] of [
    ['check cite', ['check', 'cite', 'long.txt:1', '--json'], (d: { message: string }) => d.message.length],
    ['browser', ['browser', '--json'], (d: { url: string }) => d.url.length - 'http://localhost:5173/'.length],
    // 200 lines of 800, the most a dump keeps (160 KB): a longer line makes its redaction slow.
    [
      'dump',
      ['dump', '--json', '--', 'node', '-e', "for (let i = 0; i < 200; i++) console.log('d'.repeat(800))"],
      (d: unknown) => JSON.stringify(d).match(/d{800}/g)?.length,
    ],
    ['review cost', ['review', 'cost', '--json'], (d: { rounds: unknown[] }) => d.rounds.length],
    ['review status', ['review', 'status', '--json'], (d: { state: { rounds: unknown[] } }) => d.state.rounds.length],
  ] as const) {
    test(name, () => {
      // A dump holds the configuration: the long URL would make its redaction slow.
      const q = name === 'dump' ? project() : p
      const r = cli(q, args as unknown as string[])
      if (q !== p) q.remove()
      assert.ok(r.stdout.length > 65_536, `${name} prints more than a pipe takes: ${r.stdout.length}`)
      // One document, indented or not, or one per line (lntt check).
      const first = r.stdout.startsWith('{\n') ? JSON.parse(r.stdout) : JSON.parse(r.stdout.split('\n')[0] as string)
      const expected = name === 'dump' ? 200 : name.startsWith('review') ? p.rounds : LONG
      assert.equal((read as (d: unknown) => unknown)(first), expected)
    })
  }
})
