import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'
import type { Gh } from '../src/ci/candidate.ts'
import type { Dump } from '../src/dump.ts'
import {
  commentIssue,
  fileIssue,
  ISSUE_SECTIONS,
  IssueError,
  issueBody,
  parseDraft,
  parseRepository,
  searchIssues,
  upstreamRepository,
} from '../src/issue.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const BIN = resolve(HERE, '../bin/lntt.ts')
const TEMPLATE = resolve(HERE, '../../../.github/ISSUE_TEMPLATE/lunette-report.yml')

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

const DUMP: Dump = {
  sections: [
    { title: 'lntt', lines: ['version: 0.6.2', 'installed: a dependency of the project'] },
    { title: 'Runtime', lines: ['Node: v24.1.0', 'package manager: pnpm@10.16.1', 'OS: Darwin 27.0.0 arm64'] },
    { title: 'Harness', lines: ['harness: Claude Code 2.3.4', 'model: claude-opus-5-5'] },
  ],
  harness: 'Claude Code 2.3.4',
  model: 'claude-opus-5-5',
  lntt: '0.6.2',
}

function recorder(answers: Record<string, string> = {}): Gh & { calls: { args: string[]; input?: string }[] } {
  const calls: { args: string[]; input?: string }[] = []
  return {
    calls,
    read: (args) => {
      calls.push({ args })
      return answers[args[1] as string] ?? ''
    },
    write: (args, input) => {
      calls.push({ args, ...(input === undefined ? {} : { input }) })
      return answers[args[1] as string] ?? ''
    },
  }
}

describe('the upstream repository', () => {
  test('parsed from the forms package.json and the configuration use', () => {
    assert.equal(parseRepository('git+https://github.com/LunetteOrg/starter.git'), 'LunetteOrg/starter')
    assert.equal(parseRepository('https://github.com/LunetteOrg/starter'), 'LunetteOrg/starter')
    assert.equal(parseRepository('git@github.com:LunetteOrg/starter.git'), 'LunetteOrg/starter')
    assert.equal(parseRepository('github:LunetteOrg/starter'), 'LunetteOrg/starter')
    assert.equal(parseRepository('LunetteOrg/starter'), 'LunetteOrg/starter')
    assert.equal(parseRepository('https://gitlab.com/a/b'), null)
  })

  test('cycle.retrospective.upstream.repository first, else the repository of the installed lntt', () => {
    const pkg = { repository: { url: 'git+https://github.com/LunetteOrg/starter.git' } }
    assert.equal(upstreamRepository({}, pkg), 'LunetteOrg/starter')
    assert.equal(
      upstreamRepository({ cycle: { retrospective: { upstream: { repository: 'acme/lunette' } } } }, pkg),
      'acme/lunette',
    )
    assert.throws(() => upstreamRepository({}, {}), IssueError)
  })
})

describe('parseDraft', () => {
  test('the title and the three sections, headings matched ignoring case', () => {
    assert.deepEqual(parseDraft(DRAFT), {
      title: 'lntt review loses its state when the worktree changes branch',
      whatHappened: 'The round started from zero after `git switch`.',
      pullRequests: '- acme/app#12\n- acme/app#15',
      proposal: 'Key the state by worktree, not by branch.',
    })
  })

  test('a missing title or section is named', () => {
    assert.throws(() => parseDraft(DRAFT.replace(/^# .*\n/, '')), /the draft has no title: a first line "# <title>"/)
    assert.throws(
      () => parseDraft(DRAFT.replace('## Proposal\nKey the state by worktree, not by branch.', '')),
      /the draft has no "## Proposal" section/,
    )
    assert.throws(
      () => parseDraft(DRAFT.replace('Key the state by worktree, not by branch.', '')),
      /"## Proposal" is empty/,
    )
  })
})

describe('issueBody', () => {
  test("the template's fields in its order, the whole dump at the end", () => {
    const body = issueBody(parseDraft(DRAFT), DUMP, 'acme-app')
    const headings = [...body.matchAll(/^### (.+)$/gm)].map((m) => m[1])
    assert.deepEqual(headings.slice(0, ISSUE_SECTIONS.length), [...ISSUE_SECTIONS])
    assert.match(body, /^### Project\n\nacme-app\n/)
    assert.match(body, /### Harness\n\nClaude Code 2\.3\.4\n/)
    assert.match(body, /### Model\n\nclaude-opus-5-5\n/)
    assert.match(
      body,
      /### Versions\n\nlntt 0\.6\.2 \(a dependency of the project\), Node v24\.1\.0, pnpm@10\.16\.1, Darwin 27\.0\.0 arm64\n/,
    )
    assert.match(body, /<details><summary>lntt dump<\/summary>\n\n### lntt\n/)
    assert.match(body, /<\/details>\n$/)
  })

  test('the issue template has the same fields, in the same order (.github/ISSUE_TEMPLATE/lunette-report.yml)', () => {
    const form = parseDocument(readFileSync(TEMPLATE, 'utf8')).toJS() as {
      body: { type: string; attributes?: { label?: string } }[]
    }
    const labels = form.body.filter((f) => f.type !== 'markdown').map((f) => f.attributes?.label)
    assert.deepEqual(labels, [...ISSUE_SECTIONS])
  })
})

describe('gh', () => {
  test('search lists the open issues of the repository that match, one object each', () => {
    const gh = recorder({ list: '[{"number":7,"title":"review state","url":"u7"}]' })
    assert.deepEqual(searchIssues(gh, 'LunetteOrg/starter', 'review state'), [
      { number: 7, title: 'review state', url: 'u7' },
    ])
    assert.deepEqual(gh.calls[0]?.args, [
      'issue',
      'list',
      '--repo',
      'LunetteOrg/starter',
      '--state',
      'open',
      '--search',
      'review state',
      '--json',
      'number,title,url',
      '--limit',
      '20',
    ])
  })

  test('filing and commenting pass the body on stdin', () => {
    const gh = recorder({ create: 'https://github.com/LunetteOrg/starter/issues/9', comment: 'https://c' })
    assert.equal(fileIssue(gh, 'LunetteOrg/starter', 't', 'b'), 'https://github.com/LunetteOrg/starter/issues/9')
    assert.deepEqual(gh.calls[0], {
      args: ['issue', 'create', '--repo', 'LunetteOrg/starter', '--title', 't', '--body-file', '-'],
      input: 'b',
    })
    assert.equal(commentIssue(gh, 'LunetteOrg/starter', 7, 'b'), 'https://c')
    assert.deepEqual(gh.calls[1], {
      args: ['issue', 'comment', '7', '--repo', 'LunetteOrg/starter', '--body-file', '-'],
      input: 'b',
    })
  })
})

describe('lntt issue', () => {
  let root: string
  let bin: string
  let log: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-issue-')))
    mkdirSync(join(root, '.agents'))
    writeFileSync(join(root, '.agents/config.jsonc'), '{}\n')
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

  const lntt = (args: string[], input?: string) =>
    spawnSync(process.execPath, [BIN, 'issue', ...args], {
      cwd: root,
      encoding: 'utf8',
      input,
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: root },
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

  test('--comment <n> comments on an existing issue instead', () => {
    const run = lntt(['draft.md', '--comment', '7', '--send'])
    assert.equal(run.status, 0, run.stderr)
    assert.match(sent(), /^issue comment 7 --repo LunetteOrg\/starter --body-file -/)
  })

  test('--dump reads a dump saved by lntt dump --json; --model given beside it wins', () => {
    writeFileSync(join(root, 'dump.json'), JSON.stringify(DUMP))
    const run = lntt(['draft.md', '--dump', 'dump.json'])
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /### Harness\n\nClaude Code 2\.3\.4\n/)
    const model = lntt(['draft.md', '--dump', 'dump.json', '--model', 'm9'])
    assert.match(model.stdout, /### Model\n\nm9\n/)
    assert.match(model.stdout, /- model: m9/)
  })

  test('the draft is redacted too: the home path, an email, a token', () => {
    writeFileSync(
      join(root, 'draft.md'),
      DRAFT.replace('The round started', `In ${root}/app ada@example.com saw ghp_${'a'.repeat(36)}; the round started`),
    )
    const run = lntt(['draft.md'])
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /In ~\/app <email> saw <token>; the round started/)
  })

  test('the dry run of a comment names the issue, and sends nothing', () => {
    const run = lntt(['draft.md', '--comment', '7'])
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /^To LunetteOrg\/starter#7, as a comment\n/)
    assert.equal(sent(), '')
  })

  test('a body past what GitHub takes: a warning in the dry run, a refusal with --send', () => {
    writeFileSync(join(root, 'draft.md'), DRAFT.replace('Key the state', `${'x'.repeat(70000)} Key the state`))
    const dry = lntt(['draft.md'])
    assert.equal(dry.status, 0)
    assert.match(dry.stderr, /GitHub takes 65536/)
    const send = lntt(['draft.md', '--send'])
    assert.equal(send.status, 1)
    assert.match(send.stderr, /GitHub takes 65536/)
    assert.equal(sent(), '')
  })

  test('a usage error is one before the repository is looked for', () => {
    writeFileSync(join(root, '.agents/config.jsonc'), '{ "nope": 1 }\n')
    assert.equal(lntt([]).status, 2)
    assert.equal(lntt(['draft.md']).status, 1)
  })

  test('the repository of cycle.retrospective.upstream', () => {
    writeFileSync(
      join(root, '.agents/config.jsonc'),
      '{ "cycle": { "retrospective": { "upstream": { "repository": "acme/lunette-fork" } } } }\n',
    )
    assert.match(lntt(['draft.md']).stdout, /^To acme\/lunette-fork:/)
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
    ]) {
      const run = lntt(args)
      assert.equal(run.status, 2, args.join(' '))
      assert.match(run.stderr, /usage: lntt dump/, args.join(' '))
    }
    assert.equal(sent(), '')
  })
})
