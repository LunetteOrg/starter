import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CannotRunError, cite, projectFiles, type Result } from '../src/check.ts'
import { errorLine, main } from '../src/check-cli.ts'
import { ConfigError } from '../src/index.ts'

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
      ['PASS decisions/index', 'PASS decisions/references', 'PASS decisions/residues', 'PASS decisions/names'],
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
    assert.match(r.stdout, /lntt check: \d+ PASS, 17 FAIL, 0 NOT RUN\n$/)
  })

  test('a log with no index is NOT RUN for the index check, never a silent pass', () => {
    project('clean')
    writeFileSync(
      join(repo, '.agents/config.jsonc'),
      JSON.stringify({ recording: { logs: { process: { path: 'docs/process' } } } }),
    )
    const r = results(['check', 'decisions', 'structure'])
    assert.equal(r.status, 0)
    const index = r.results.filter((x) => x.check === 'index')
    assert.deepEqual(
      index.map((x) => x.status),
      ['NOT RUN'],
    )
    assert.match((index[0] as Result).message, /recording\.logs\.process has no index/)
  })

  test('a project with no recording section is NOT RUN', () => {
    project('clean')
    writeFileSync(join(repo, '.agents/config.jsonc'), '{}')
    const r = results(['check', 'decisions'])
    assert.equal(r.status, 0)
    assert.deepEqual(
      r.results.map((x) => [x.status, x.message]),
      [['NOT RUN', 'no recording section in the configuration']],
    )
  })

  test('files of a nested project, with a configuration of its own, are its own check', () => {
    project('clean')
    mkdirSync(join(repo, 'templates/web/.agents'), { recursive: true })
    writeFileSync(join(repo, 'templates/web/.agents/config.jsonc'), '{}')
    writeFileSync(join(repo, 'templates/web/README.md'), 'Its own docs/adr/storage-two.md.\n')
    assert.equal(results(['check', 'decisions', 'structure']).status, 0)
  })

  test("externalReferences: files citing another project's records are not resolved, a stale glob fails", () => {
    project('clean')
    mkdirSync(join(repo, 'shared'))
    writeFileSync(join(repo, 'shared/rule.ts'), '// The project that installs it: docs/adr/its-own.md\n')
    assert.deepEqual(fails(results(['check', 'decisions', 'structure']).results), ['references shared/rule.ts:1'])
    const config = (external: Record<string, string>) =>
      writeFileSync(
        join(repo, '.agents/config.jsonc'),
        JSON.stringify({
          recording: {
            logs: { adr: { path: 'docs/adr', index: 'docs/adr/README.md', template: 'docs/adr/template.md' } },
            externalReferences: external,
          },
        }),
      )
    config({ 'shared/**': 'installed in every project, citing its records' })
    const r = results(['check', 'decisions', 'structure'])
    assert.equal(r.status, 0)
    assert.match((r.results.find((x) => x.check === 'references') as Result).message, /1 citing another project/)
    config({ 'shared/**': 'installed in every project', 'gone/**': 'a package since removed' })
    const stale = results(['check', 'decisions', 'structure']).results.filter((x) => x.status === 'FAIL')
    assert.deepEqual(
      stale.map((x) => x.message),
      ['recording.externalReferences["gone/**"] matches no file: remove it'],
    )
  })

  test('a sentence that ends on a log folder and goes on with a word is not a wrapped path', () => {
    project('clean')
    writeFileSync(join(repo, 'src/notes.ts'), '// Records live in docs/adr/\n// and nowhere else.\nexport {}\n')
    assert.deepEqual(fails(results(['check', 'decisions', 'structure']).results), [])
    writeFileSync(join(repo, 'src/notes.ts'), '// The record is docs/adr/\n// gone-now.md.\nexport {}\n')
    assert.deepEqual(fails(results(['check', 'decisions', 'structure']).results), ['references src/notes.ts:1'])
  })

  test('status: only a template that lists the statuses says which the log allows', () => {
    project('clean')
    const names = () => results(['check', 'decisions', 'structure']).results.filter((x) => x.check === 'names')
    // A record with no status, against a template that lists them, fails.
    writeFileSync(join(repo, 'docs/adr/api-shape.md'), '# API shape\n')
    assert.deepEqual(fails(names()), ['names docs/adr/api-shape.md:1'])
    assert.match((names()[0] as Result).message, /no status in the frontmatter: one of proposed, accepted/)
    // A template with a status and no list allows any status: none is checked, and the
    // report says so.
    writeFileSync(join(repo, 'docs/adr/template.md'), '---\nstatus: proposed\n---\n\n# Subject\n')
    assert.deepEqual(fails(names()), [])
    assert.match((names()[0] as Result).message, /no template listing two statuses or more/)
    // So does a template that lists a single status.
    writeFileSync(join(repo, 'docs/adr/template.md'), '---\nstatus: proposed # proposed\n---\n\n# Subject\n')
    assert.deepEqual(fails(names()), [])
    assert.match((names()[0] as Result).message, /no template listing two statuses or more/)
    // So does a template that is not there.
    rmSync(join(repo, 'docs/adr/template.md'))
    assert.deepEqual(fails(names()), [])
    assert.match((names()[0] as Result).message, /no template listing two statuses or more/)
  })

  test('a number with a mark before the subject, or ADR and a number, fails; a count, a version, a time are words', () => {
    project('clean')
    const title = (t: string) => {
      writeFileSync(join(repo, 'docs/adr/api-shape.md'), `---\nstatus: proposed\n---\n\n# ${t}\n`)
      return fails(results(['check', 'decisions', 'structure']).results).filter((f) => f.startsWith('names'))
    }
    assert.deepEqual(title('3 retries at most'), [])
    for (const t of [
      '2.0 migration plan',
      '2.x release',
      '3.js intro',
      '7:30 standup',
      '1.2 Plan',
      '1.record decisions',
      '12 retries',
      '2024 review',
      '1.2.3 Plan',
      '0003 Old thing',
      '2–3 retries',
      '3-way merge',
      '2024-10 review',
      'LADR 5 notes',
      'adr 5 notes',
      `Why \`ADR ${5}\` was dropped`,
      'ADR process',
      '1)storage',
      '1:word',
    ])
      assert.deepEqual(title(t), [], t)
    for (const t of [
      '1. Record decisions',
      '1.Record decisions',
      '1.',
      '7: Caching',
      '7:Caching',
      '7 — Caching',
      '1) Storage',
      '12 — API shape',
      '7 - Caching',
      '7 – Caching',
      '0003—Old thing',
      '0003 — Old thing',
      `ADR ${12} API shape`,
      `PDR-${12} pricing`,
      `ADR#${3} storage`,
      `ADR${12} storage`,
      `Why ADR ${5} matters`,
    ]) {
      assert.deepEqual(title(t), ['names docs/adr/api-shape.md:5'], t)
    }
    // A code span is not a reference; the rest of the title still is, and the message
    // quotes the title as written.
    assert.deepEqual(title(`Why \`ADR ${5}\` and ADR ${6}`), ['names docs/adr/api-shape.md:5'])
    const names = results(['check', 'decisions', 'structure']).results.filter((x) => x.check === 'names')
    assert.equal((names[0] as Result).message, `the title carries a number: # Why \`ADR ${5}\` and ADR ${6}`)
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

  test('a base that does not resolve is NOT RUN', () => {
    const r = results(['check', 'decisions', '--base', 'nowhere'])
    const inventory = r.results.find((x) => x.check === 'inventory') as Result
    assert.equal(inventory.status, 'NOT RUN')
    assert.match(inventory.message, /nowhere/)
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

  test('issue numbers and dates are identifiers; "N of M" is a figure', () => {
    project('clean')
    writeFileSync(
      join(repo, 'docs/adr/api-shape.md'),
      '# API shape\n\nSee #12, decided on 2026-10-01.\n\n3 of 4 calls read.\n',
    )
    assert.deepEqual(
      results(['check', 'decisions', 'numbers', 'docs/adr/api-shape.md']).results.map((x) => x.line),
      [5],
    )
  })

  test('a file that does not exist, or a folder, fails; no file and no base is a usage error', () => {
    project('clean')
    assert.deepEqual(
      fails(results(['check', 'decisions', 'numbers', 'docs/adr/nope.md', 'docs/adr']).results),
      ['figures docs/adr/nope.md:null', 'figures docs/adr:null'].sort(),
    )
    assert.equal(lntt(['check', 'decisions', 'numbers']).status, 2)
  })

  test('numbers with a base that does not resolve is NOT RUN', () => {
    project('clean')
    const r = results(['check', 'decisions', 'numbers', '--base', 'nowhere'])
    assert.deepEqual(
      r.results.map((x) => x.status),
      ['NOT RUN'],
    )
    assert.match((r.results[0] as Result).message, /does not resolve, or has no merge base/)
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

  test('cite reads a heading anchor, a line range and a leading ./ as the line they name', () => {
    project('clean')
    assert.deepEqual(cite(repo, './src/app.ts', 3), { text: 'export const answer = 42' })
    assert.deepEqual(cite(repo, 'src/app.ts:3-4', null), { text: 'export const answer = 42' })
    assert.deepEqual(cite(repo, 'src/app.ts:3:7', null), { text: 'export const answer = 42' })
    assert.deepEqual(cite(repo, 'src/app.ts:3–4', null), { text: 'export const answer = 42' })
    assert.deepEqual(cite(repo, 'src/app.ts:3,1', null), { text: 'export const answer = 42' })
    assert.deepEqual(cite(repo, 'docs/adr/storage.md#decision', null), { text: null })
    assert.deepEqual(cite(repo, join(repo, 'src/app.ts'), 1), {
      text: '// Where data lives: docs/adr/storage.md. How it answers: docs/adr/',
    })
    assert.deepEqual(cite(repo, '../outside.ts', 1), { missing: 'no such file', what: 'file' })
    assert.deepEqual(cite(repo, join(tmpdir(), 'outside.ts'), 1), { missing: 'no such file', what: 'file' })
    assert.deepEqual(cite(repo, 'src/app.ts', 9), { missing: 'no line 9: the file has 3 lines', what: 'line' })
  })
})

describe('lntt check', () => {
  test('alone runs every area: the AGENTS.md block, the installed skills, the decision logs, the tests and (not run, with no body) the pull request body', () => {
    project('clean')
    const r = results(['check'])
    assert.equal(r.status, 0)
    assert.deepEqual([...new Set(r.results.map((x) => x.area))], ['agents-md', 'skills', 'decisions', 'tests', 'body'])
  })

  test('the files every area reads leave out the stubs of the shared skills, not the project skills beside them', () => {
    project('clean')
    mkdirSync(join(repo, '.claude/skills/issues'), { recursive: true })
    writeFileSync(join(repo, '.claude/skills/issues/SKILL.md'), 'our own skill\n')
    const files = projectFiles(repo)
    assert.deepEqual(
      files.filter((f) => f.startsWith('.agents/skills/') || f.startsWith('.claude/skills/')),
      ['.claude/skills/issues/SKILL.md'],
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
    assert.match((r.results[0] as Result).message, /run lntt sync/)
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

  test('an unknown flag, a file to a check that takes none, a base that looks like a flag: usage errors', () => {
    project('clean')
    for (const args of [
      ['check', '--nope'],
      ['check', 'decisions', 'structure', 'docs/adr/storage.md'],
      ['check', 'decisions', '--base=-x'],
      ['check', 'decisions', '--base='],
      ['check', '--base='],
      ['check', '--base=-x'],
    ]) {
      const r = lntt(args)
      assert.equal(r.status, 2, args.join(' '))
      assert.equal(r.stdout, '')
    }
    assert.match(lntt(['check', '--base=']).stderr, /--base '' is not a ref/)
  })

  test('a usage error is one in a project with no configuration too', () => {
    git('init', '-q')
    for (const [args, why] of [
      [['check', 'nope'], /no area nope/],
      [['check', '--base='], /--base '' is not a ref/],
      [['check', '--base=-x'], /--base -x is not a ref/],
      [['check', 'cite'], /give at least one path:line/],
      [['check', 'cite', 'src/app.ts'], /src\/app\.ts is not path:line/],
      [['check', 'decisions', 'structure', 'docs/adr/storage.md'], /structure takes no file/],
      [['check', 'cite', 'src/app.ts:1', '--base='], /--base '' is not a ref/],
      [['check', 'agents-md', 'AGENTS.md'], /no check AGENTS\.md in agents-md/],
      [['check', 'decisions', 'numbers'], /numbers needs files or --base/],
    ] as [string[], RegExp][]) {
      const r = lntt(args)
      assert.equal(r.status, 2, args.join(' '))
      assert.match(r.stderr, why, args.join(' '))
    }
  })

  test('a configuration error and a check that cannot run are one line; a defect keeps its stack', () => {
    assert.equal(errorLine(new ConfigError('bad config')), 'lntt: bad config')
    assert.equal(errorLine(new CannotRunError('no git')), 'lntt: error: no git')
    assert.equal(errorLine(new TypeError('a bug')), null)
    assert.throws(
      () =>
        main([], () => {
          throw new TypeError('a bug')
        }),
      /a bug/,
    )
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
