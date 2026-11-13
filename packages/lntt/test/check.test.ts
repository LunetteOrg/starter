import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Result } from '../src/check/results.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = resolve(HERE, '../bin/lntt.ts')
const FIXTURES = join(HERE, 'fixtures/decisions')

let repo: string

function git(...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: repo,
    encoding: 'utf8',
  }).trim()
}

// A fixture copied into a repository of its own, committed, with AGENTS.md in step.
function project(fixture: string): void {
  cpSync(join(FIXTURES, fixture), repo, { recursive: true })
  git('init', '-q', '-b', 'main')
  lntt(['sync'])
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
}

// git never looks above the test's repository, wherever the temp directory is.
function lntt(args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(repo) },
  })
}

function results(args: string[]): { status: number | null; results: Result[] } {
  const r = lntt([...args, '--json'])
  return {
    status: r.status,
    results: r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Result),
  }
}

// Each FAIL as `check path:line`, to compare with the defects a fixture plants.
function fails(list: Result[]): string[] {
  return list
    .filter((r) => r.status === 'FAIL')
    .map((r) => `${r.check} ${r.path}:${r.line}`)
    .sort()
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-check-')))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('lntt check decisions structure', () => {
  test('passes on logs that follow the rules, one PASS per check, exit 0', () => {
    project('clean')
    const r = results(['check', 'decisions', 'structure'])
    assert.equal(r.status, 0)
    assert.deepEqual(
      r.results.map((x) => `${x.status} ${x.area}/${x.check}`),
      [
        'PASS decisions/index',
        'PASS decisions/references',
        'NOT RUN decisions/board-refs',
        'PASS decisions/residues',
        'PASS decisions/names',
      ],
    )
    const index = r.results.find((x) => x.check === 'index') as Result
    assert.match(index.message, /adr: 2 records, 2 rows/)
    assert.match((r.results.find((x) => x.check === 'names') as Result).message, /status \(proposed\|accepted\)/)
  })

  test('finds every planted defect at its line, exit 1', () => {
    project('defects')
    const r = results(['check', 'decisions', 'structure'])
    assert.equal(r.status, 1)
    assert.deepEqual(
      fails(r.results),
      [
        // index and files, both ways
        'index docs/adr/README.md:6',
        'index docs/adr/README.md:7',
        'index docs/adr/unindexed.md:1',
        // a record's file name, title and status
        'names docs/adr/0003-old-thing.md:1',
        'names docs/adr/api-shape.md:2',
        'names docs/adr/api-shape.md:6',
        'names docs/adr/no-title.md:1',
        // references: a broken link, numbered ones (the title's too), paths in code, one wrapped
        'references docs/adr/api-shape.md:6',
        'references docs/adr/storage.md:10',
        'references docs/adr/storage.md:10',
        'references src/app.ts:1',
        'references src/app.ts:1',
        'references src/app.ts:2',
        // append-only residues, in every log
        'residues docs/adr/storage.md:13',
        'residues docs/adr/storage.md:15',
        'residues docs/adr/storage.md:17',
        'residues docs/process/notes.md:5',
      ].sort(),
    )
    const messages = r.results.map((x) => x.message).join('\n')
    assert.match(messages, /docs\/adr\/also-gone\.md/)
    assert.match(messages, /rejected/)
    assert.match(messages, /never indexed/)
  })

  test('the text report lists each result and ends with the counts', () => {
    project('defects')
    const r = lntt(['check', 'decisions'])
    assert.equal(r.status, 1)
    assert.match(r.stdout, /^FAIL {5}decisions\/index {2}docs\/adr\/README\.md:6 — /m)
    assert.match(r.stdout, /lntt check: \d+ PASS, 17 FAIL, 1 NOT RUN\n$/)
  })

  test('an untracked record is seen: a new file left out of the index fails before it is added', () => {
    project('clean')
    writeFileSync(join(repo, 'docs/adr/caching.md'), '---\nstatus: accepted\n---\n\n# Caching\n')
    assert.deepEqual(fails(results(['check', 'decisions', 'structure']).results), ['index docs/adr/caching.md:1'])
  })
})

describe('lntt check decisions --base', () => {
  beforeEach(() => {
    project('clean')
    git('switch', '-q', '-c', 'feat/1/change')
  })

  test('the diff inventory: which records and which code the change touches', () => {
    appendFileSync(join(repo, 'docs/adr/api-shape.md'), '\nAbout 120 requests a second.\n')
    appendFileSync(join(repo, 'src/app.ts'), 'export const other = 1\n')
    git('rm', '-q', 'docs/process/review.md')
    writeFileSync(join(repo, 'docs/process/README.md'), '# Process\n')
    writeFileSync(join(repo, 'docs/adr/storage.md'), '---\nstatus: accepted\n---\n\n# Storage\n')
    git('commit', '-q', '-am', 'change')
    const r = results(['check', 'decisions', '--base', 'main'])
    assert.equal(r.status, 0)
    const inventory = r.results.filter((x) => x.check === 'inventory').map((x) => `${x.path} ${x.message}`)
    assert.deepEqual(inventory, [
      'docs/adr/api-shape.md adr record, modified',
      'docs/adr/storage.md adr record, modified',
      'docs/process/review.md process record, deleted: no longer at this path',
      'null 2 other files: docs/process/README.md, src/app.ts',
    ])
    // The figures of the records the change touches.
    const figures = r.results.filter((x) => x.check === 'figures').map((x) => `${x.path}:${x.line} ${x.message}`)
    assert.deepEqual(figures, ['docs/adr/api-shape.md:12 About 120 requests a second.'])
  })

  test('residues and names are checked on the records the diff touches only', () => {
    git('switch', '-q', 'main')
    writeFileSync(join(repo, 'docs/adr/api-shape.md'), '---\nstatus: proposed\n---\n\n# API shape\n\n## Addendum\n')
    git('commit', '-q', '-am', 'a residue already on main')
    git('switch', '-q', 'feat/1/change')
    git('rebase', '-q', 'main')
    appendFileSync(join(repo, 'docs/adr/storage.md'), '\n~~struck~~\n')
    git('commit', '-q', '-am', 'change')
    assert.deepEqual(fails(results(['check', 'decisions', '--base', 'main']).results), [
      'residues docs/adr/storage.md:24',
    ])
    assert.deepEqual(fails(results(['check', 'decisions']).results), [
      'residues docs/adr/api-shape.md:7',
      'residues docs/adr/storage.md:24',
    ])
  })
})

describe('lntt check decisions board-refs', () => {
  // The clean fixture, with its process log forbidding board references.
  function strict(): void {
    project('clean')
    writeFileSync(
      join(repo, '.agents/config.jsonc'),
      JSON.stringify({
        recording: {
          logs: {
            adr: { path: 'docs/adr', index: 'docs/adr/README.md', template: 'docs/adr/template.md' },
            process: { path: 'docs/process', index: 'docs/process/README.md', boardReferences: false },
          },
        },
      }),
    )
  }

  const boardRefs = (list: Result[]) =>
    list.filter((x) => x.check === 'board-refs').map((x) => `${x.status} ${x.path}:${x.line} ${x.message}`)

  test('with files, only those in a log that forbids them: what pre-commit passes', () => {
    strict()
    writeFileSync(join(repo, 'docs/process/review.md'), '# Review\n\nSee #3.\n')
    appendFileSync(join(repo, 'docs/process/README.md'), '\nOpened in #4.\n')
    appendFileSync(join(repo, 'docs/adr/storage.md'), '\nDecided in #12.\n')
    // A path given that is not on disk is not read.
    const r = results([
      'check',
      'decisions',
      'board-refs',
      'docs/process/review.md',
      'docs/adr/storage.md',
      'gone.md',
      'docs/process/gone.md',
    ])
    assert.equal(r.status, 1)
    assert.deepEqual(fails(r.results), ['board-refs docs/process/review.md:3'])
    // A path is read from where lntt runs, as a shell gives it.
    const from = (cwd: string, files: string[]) =>
      spawnSync(process.execPath, [BIN, 'check', 'decisions', 'board-refs', ...files], {
        cwd: join(repo, cwd),
        encoding: 'utf8',
        env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(repo) },
      })
    for (const [cwd, file] of [
      ['.', './docs/process/review.md'],
      ['docs', 'process/review.md'],
      ['docs', join(repo, 'docs/process/review.md')],
    ] as const) {
      const run = from(cwd, [file])
      assert.equal(run.status, 1, `${cwd} ${file}`)
      assert.match(run.stdout, /board-refs {2}docs\/process\/review\.md:3 /, `${cwd} ${file}`)
    }
    const clean = results(['check', 'decisions', 'board-refs', 'docs/adr/storage.md'])
    assert.equal(clean.status, 0)
    assert.deepEqual(boardRefs(clean.results), [
      'PASS null:null no board reference in the files given: 0 of 1 in process (boardReferences: false)',
    ])
  })
})

describe('lntt check decisions numbers', () => {
  test('every line of a record carrying a figure, frontmatter and issue numbers apart', () => {
    project('clean')
    const r = results(['check', 'decisions', 'numbers', 'docs/adr/storage.md'])
    assert.equal(r.status, 0)
    assert.deepEqual(
      r.results.map((x) => `${x.status} ${x.check} ${x.path}:${x.line} ${x.message}`),
      ['INFO figures docs/adr/storage.md:22 About 45% of the requests read one row.'],
    )
  })
})

describe('lntt check cite', () => {
  test('prints what is on each line; a line or a file that does not exist fails', () => {
    project('clean')
    const r = results(['check', 'cite', 'src/app.ts:3', 'src/app.ts:9', 'src/nope.ts:1'])
    assert.equal(r.status, 1)
    assert.deepEqual(
      r.results.map((x) => `${x.status} ${x.path}:${x.line} ${x.message}`),
      [
        'PASS src/app.ts:3 export const answer = 42',
        'FAIL src/app.ts:9 no line 9: the file has 3 lines',
        'FAIL src/nope.ts:1 no such file',
      ],
    )
  })

  test('an anchor that is not path:line is a usage error; a range or a list names its first line', () => {
    project('clean')
    assert.equal(lntt(['check', 'cite', 'src/app.ts']).status, 2)
    assert.deepEqual(
      results(['check', 'cite', 'src/app.ts:3-4', 'src/app.ts:3–4', 'src/app.ts:3,1']).results.map(
        (x) => `${x.status} ${x.path}:${x.line}`,
      ),
      ['PASS src/app.ts:3', 'PASS src/app.ts:3', 'PASS src/app.ts:3'],
    )
  })
})

describe('lntt check', () => {
  test('alone runs every area: the AGENTS.md block, the installed skills, the plugin settings, the synced workflow lines, the decision logs, the tests and (not run, with no body) the pull request body', () => {
    project('clean')
    const r = results(['check'])
    assert.equal(r.status, 0)
    assert.deepEqual(
      [...new Set(r.results.map((x) => x.area))],
      ['agents-md', 'skills', 'plugin', 'workflows', 'decisions', 'tests', 'body'],
    )
  })

  test('agents-md fails on a hand edit of the managed block', () => {
    project('clean')
    writeFileSync(join(repo, 'AGENTS.md'), '<!-- lunette:start -->\nmine\n<!-- lunette:end -->\n')
    const r = results(['check', 'agents-md'])
    assert.equal(r.status, 1)
    assert.deepEqual(
      r.results.map((x) => `${x.status} ${x.area}/${x.check} ${x.path}`),
      ['FAIL agents-md/block AGENTS.md'],
    )
    assert.match((r.results[0] as Result).message, /run pnpm exec lntt sync/)
  })

  test('an unknown area or check is a usage error that runs nothing', () => {
    project('clean')
    for (const args of [
      ['check', 'nope'],
      ['check', 'decisions', 'nope'],
      ['check', 'agents-md', 'nope'],
    ]) {
      const r = lntt(args)
      assert.equal(r.status, 2, args.join(' '))
      assert.equal(r.stdout, '')
    }
  })

  test('outside a git repository the check cannot run: one line on stderr, no stack trace', () => {
    cpSync(join(FIXTURES, 'clean'), repo, { recursive: true })
    const r = lntt(['check', 'decisions'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /^lntt: error: /)
    assert.doesNotMatch(r.stderr, /\n\s+at /)
  })

  test('no configuration file is a configuration error', () => {
    git('init', '-q')
    const r = lntt(['check'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /^lntt: no \.agents\/config/)
  })
})
