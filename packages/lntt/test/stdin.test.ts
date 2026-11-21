import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '../src')
const BIN = resolve(HERE, '../bin/lntt.ts')

// How long the writer waits before its first byte: long enough for the reader to be at
// stdin already, so that a synchronous read finds an empty pipe.
const LATE_MS = 700

// No Orca or Herdr variables, nor a git directory, leak from the session running the tests.
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(ORCA_|HERDR_|TERM_PROGRAM|LNTT_|GIT_)/.test(k)),
)

// Runs lntt with a pipe on stdin whose writer starts late, as a child that sleeps and then
// writes does: the input arrives in two pieces, the first after LATE_MS.
function lateWriter(
  args: string[],
  cwd: string,
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  node: string[] = [],
) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [...node, BIN, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d
    })
    child.stderr.on('data', (d) => {
      stderr += d
    })
    child.on('error', reject)
    child.on('close', (status) => resolvePromise({ status, stdout, stderr }))
    // Cut by bytes: in the middle, or one byte into the first euro sign, so that a character
    // falls across the two pieces.
    const bytes = Buffer.from(input)
    const euro = bytes.indexOf('€')
    const half = euro === -1 ? Math.floor(bytes.length / 2) : euro + 1
    setTimeout(() => {
      child.stdin.write(bytes.subarray(0, half))
      setTimeout(() => child.stdin.end(bytes.subarray(half)), 200)
    }, LATE_MS)
  })
}

let dir: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-stdin-')))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('a command that reads stdin waits for a writer that starts late and reads to its end', () => {
  test('lntt check body -', async () => {
    mkdirSync(join(dir, '.agents'))
    const retrospective = { heading: '🔁 Retro', lines: ['Friction', 'Review cost'] }
    writeFileSync(join(dir, '.agents/config.jsonc'), JSON.stringify({ delivery: { pullRequest: { retrospective } } }))
    const body =
      '<!-- retro:start -->\n- **Friction:** none\n- **Review cost:** 1 round, 0.4M tokens, $0.52\n<!-- retro:end -->'
    const r = await lateWriter(['check', 'body', '-', '--json'], dir, body)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout).status, 'PASS')
  })

  test('lntt branch check --pre-push', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
    git('init', '-q', '-b', 'main')
    const ZERO = '0'.repeat(40)
    const SHA = '1'.repeat(40)
    // The branch named on the second line is past the middle of the input: a read cut at the
    // first piece never sees it.
    const input = `refs/heads/a ${SHA} refs/heads/feat/1/ok ${ZERO}\nrefs/heads/b ${SHA} refs/heads/wip ${ZERO}\n`
    const r = await lateWriter(['branch', 'check', '--pre-push'], dir, input)
    assert.equal(r.status, 1, r.stderr)
    assert.match(r.stderr, /wip/)
  })

  test('lntt hook typecheck', async () => {
    const input = JSON.stringify({ session_id: 'late-writer', padding: 'x'.repeat(50) })
    const r = await lateWriter(['hook', 'typecheck'], dir, input)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /removed in 0\.6\.5/)
  })

  test('lntt refs', async () => {
    const input = `${'x'.repeat(40)} and then C#5 at the end\n`
    const r = await lateWriter(['refs'], dir, input)
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(
      JSON.parse(r.stdout).mentions.map((m: { text: string }) => m.text),
      ['C#5'],
    )
  })

  test('lntt ask --to orchestrator -', async () => {
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, stdio: 'ignore' })
    git('init', '-q', '-b', 'main')
    git('commit', '-q', '--allow-empty', '-m', 'init')
    const question = 'A question\na€€€ over lines, written late\n'
    const r = await lateWriter(
      ['ask', '--to', 'orchestrator', '--timeout', '0.1', '--interval', '0.05', '-'],
      dir,
      question,
      cleanEnv,
    )
    assert.match(r.stderr, /no answer to .* in 0\.1 s/)
    const box = join(dir, '.git/lntt-messages/to-orchestrator')
    const [file] = readdirSync(box)
    assert.equal(readFileSync(join(box, file as string), 'utf8'), question)
  })

  test('lntt answer <id> -', async () => {
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, stdio: 'ignore' })
    git('init', '-q', '-b', 'main')
    git('commit', '-q', '--allow-empty', '-m', 'init')
    const box = join(dir, '.git/lntt-messages/to-orchestrator')
    mkdirSync(box, { recursive: true })
    writeFileSync(join(box, '20261015-090000-late.md'), 'Which one?\n')
    const reply = 'Level 2, a€€€ and more\n'
    const r = await lateWriter(['answer', '20261015-090000-late', '-'], dir, reply, cleanEnv)
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readFileSync(join(box, '20261015-090000-late.answer.md'), 'utf8'), reply)
  })

  test('lntt hook typecheck does not wait on a terminal', async () => {
    // stdin is a pipe that never closes, which a terminal looks like to the hook.
    const r = await new Promise<{ status: number | null }>((done) => {
      const child = spawn(
        process.execPath,
        ['--import', 'data:text/javascript,process.stdin.isTTY=true', BIN, 'hook', 'typecheck'],
        { cwd: dir, env: cleanEnv, stdio: ['pipe', 'ignore', 'ignore'] },
      )
      const stuck = setTimeout(() => child.kill(), 8000)
      child.on('close', (status) => {
        clearTimeout(stuck)
        done({ status })
      })
    })
    assert.equal(r.status, 0)
  })
})

describe('no command reads stdin synchronously', () => {
  const sources = (d = SRC): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = join(d, e.name)
      if (e.isDirectory()) return sources(p)
      return e.name.endsWith('.ts') ? [p] : []
    })
  // A read of descriptor 0, of /dev/stdin, or of anything named stdin or fd.
  const found = (text: string) =>
    [...text.matchAll(/\b(?:readFileSync|readSync)\(\s*(?:0\b|['"`]\/dev\/stdin['"`]|[^,)]*\b(?:stdin|fd)\b)/g)].map(
      (m) => m.index,
    )

  test('no readFileSync(0 is left in packages/lntt/src', () => {
    const hits = sources().flatMap((f) =>
      found(readFileSync(f, 'utf8')).map((i) => `${relative(dirname(SRC), f)}@${i}`),
    )
    assert.deepEqual(hits, [], 'read stdin with readStdin (src/stdin.ts), which waits for end')
  })

  test('the scan sees each form of a synchronous read', () => {
    for (const form of [
      'readFileSync(0, "utf8")',
      'readFileSync( 0)',
      "readFileSync('/dev/stdin', 'utf8')",
      "readFileSync(first === '-' ? stdin.fd : path, 'utf8')",
      'readFileSync(fd, "utf8")',
      'readSync(0, buffer)',
      'fs.readFileSync(process.stdin.fd)',
    ]) {
      assert.equal(found(form).length, 1, form)
    }
    assert.equal(found('readFileSync(path)').length, 0)
  })
})
