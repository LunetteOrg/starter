import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = resolve(HERE, '../bin/lntt.ts')

const DRAFT = [
  '# lntt review loses its state when the worktree changes branch',
  '',
  '## What happened',
  'The round started from zero after `git switch`.',
  '',
  '## Pull requests',
  '- acme/app#12',
  '- acme/app#15',
  '',
  '## Proposal',
  'Key the state by worktree, not by branch.',
].join('\n')

const UPSTREAM = '{ "cycle": { "retrospective": { "upstream": { "repository": "LunetteOrg/starter" } } } }\n'

// The main paths of lntt issue, through the CLI as a process with a gh on PATH; the rest of its
// behaviour is in src/issue/command.spec.ts, the draft and the body in src/issue.spec.ts.
describe('lntt issue', () => {
  let root: string
  let bin: string
  let log: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-issue-')))
    mkdirSync(join(root, '.agents'))
    writeFileSync(join(root, '.agents/config.jsonc'), UPSTREAM)
    writeFileSync(join(root, 'package.json'), '{"name":"acme-app"}')
    writeFileSync(join(root, 'draft.md'), DRAFT)
    bin = join(root, 'bin')
    mkdirSync(bin)
    log = join(root, 'gh.log')
    // A gh that records its arguments and stdin, and answers create, comment and list.
    writeFileSync(
      join(bin, 'gh'),
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> ${log}`,
        `cat >> ${log}`,
        'case "$2" in',
        '  create) echo https://github.com/LunetteOrg/starter/issues/9 ;;',
        '  comment) echo https://github.com/LunetteOrg/starter/issues/7#c ;;',
        `  list) echo '[{"number":7,"title":"t","url":"u"}]' ;;`,
        'esac',
      ].join('\n'),
    )
    chmodSync(join(bin, 'gh'), 0o755)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const lntt = (args: string[], input?: string, extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [BIN, 'issue', ...args], {
      cwd: root,
      encoding: 'utf8',
      input,
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, ...extra },
    })
  const sent = () => {
    try {
      return readFileSync(log, 'utf8')
    } catch {
      return ''
    }
  }

  test('without --send it prints the whole issue and sends nothing', () => {
    const run = lntt(['draft.md', '--model', 'm1'])
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /^To LunetteOrg\/starter: lntt review loses its state/)
    assert.match(run.stdout, /### Model\n\nm1\n/)
    assert.match(run.stdout, /### Project\n\nacme-app\n/)
    assert.match(run.stderr, /nothing sent: --send opens it/)
    assert.equal(sent(), '')
  })

  test('--send opens it with gh on the upstream repository and prints its URL', () => {
    const run = lntt(['-', '--send'], DRAFT)
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stdout, 'https://github.com/LunetteOrg/starter/issues/9\n')
    assert.match(sent(), /^issue create --repo LunetteOrg\/starter --title lntt review loses its state/)
    assert.match(sent(), /### What happened\n\nThe round started from zero/)
  })

  test("the project's template and version, from the lunette key, in the Project field", () => {
    writeFileSync(
      join(root, '.agents/config.jsonc'),
      UPSTREAM.replace(/^\{/, '{ "lunette": { "template": "react-router", "version": "0.4.1" },'),
    )
    const run = lntt(['draft.md'])
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /### Project\n\nacme-app, template react-router, @lntt\/create 0\.4\.1\n/)
    assert.match(run.stdout, /- template: react-router, @lntt\/create 0\.4\.1/)
  })

  test('search prints one JSON line per open issue that matches', () => {
    const run = lntt(['search', 'review', 'state'])
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stdout, '{"number":7,"title":"t","url":"u"}\n')
    assert.match(sent(), /^issue list --repo LunetteOrg\/starter --state open --search review state/)
  })

  test('a draft with a missing section exits 1 naming it; a usage error exits 2', () => {
    writeFileSync(join(root, 'draft.md'), '# t\n## What happened\nx\n')
    const run = lntt(['draft.md'])
    assert.equal(run.status, 1)
    assert.match(run.stderr, /no "## Pull requests" section/)
    for (const args of [
      [],
      ['draft.md', '--comment', 'x'],
      ['draft.md', '--comment', '0'],
      ['draft.md', '--comment', '07'],
      ['draft.md', '--json'],
      ['draft.md', '--', 'ls'],
      ['search'],
      ['search', 'x', '--send'],
      ['draft.md', '--repo', 'starter'],
      ['draft.md', '--repo', 'a/b/c'],
    ]) {
      const run = lntt(args)
      assert.equal(run.status, 2, args.join(' '))
      assert.match(run.stderr, /usage: lntt dump/, args.join(' '))
    }
    assert.equal(sent(), '')
  })
})
