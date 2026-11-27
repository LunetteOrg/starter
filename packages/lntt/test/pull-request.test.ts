import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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

// The commands that read the retrospective block; the block's logic is src/pull-request.spec.ts.
const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/lntt.ts')

describe('lntt pr block and lntt check body', () => {
  let tmp: string
  let stubs: string
  let repo: string

  function lntt(args: string[], input?: string) {
    return spawnSync(process.execPath, [BIN, ...args], {
      cwd: repo,
      encoding: 'utf8',
      input,
      env: { ...process.env, PATH: `${stubs}:${process.env.PATH}` },
    })
  }

  // A fake gh that records its arguments and prints the body, or fails.
  function gh(answer: string, status = 0): void {
    writeFileSync(
      join(stubs, 'gh'),
      `#!/bin/sh\necho "$*" > "${join(tmp, 'gh-args')}"\ncat <<'EOF'\n${answer}\nEOF\nexit ${status}\n`,
    )
    chmodSync(join(stubs, 'gh'), 0o755)
  }

  function ghArgs(): string {
    return readFileSync(join(tmp, 'gh-args'), 'utf8')
  }

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-pr-')))
    stubs = join(tmp, 'bin')
    repo = join(tmp, 'repo')
    mkdirSync(stubs)
    mkdirSync(join(repo, '.agents'), { recursive: true })
    const retrospective = { heading: '🔁 Retro', lines: ['Friction', 'Review cost'] }
    writeFileSync(join(repo, '.agents/config.jsonc'), JSON.stringify({ delivery: { pullRequest: { retrospective } } }))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('lntt pr block prints the empty block of the configuration', () => {
    const r = lntt(['pr', 'block'])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(
      r.stdout,
      '## 🔁 Retro\n<!-- retro:start -->\n- **Friction:**\n- **Review cost:**\n<!-- retro:end -->\n',
    )
  })

  test('lntt pr: a usage error exits 2', () => {
    assert.equal(lntt(['pr', 'block', 'more']).status, 2)
    assert.equal(lntt(['pr', 'check']).status, 2)
  })

  test('- reads the body on stdin: PASS when filled, a FAIL per problem', () => {
    const filled =
      '<!-- retro:start -->\n- **Friction:** none\n- **Review cost:** 1 round, 0.4M tokens, $0.52\n<!-- retro:end -->'
    const pass = lntt(['check', 'body', '-', '--json'], filled)
    assert.equal(pass.status, 0, pass.stderr)
    assert.deepEqual(JSON.parse(pass.stdout), {
      area: 'body',
      check: 'retrospective',
      status: 'PASS',
      path: null,
      line: null,
      message: 'stdin: every retrospective label is filled',
    })
    const r = lntt(['check', 'body', '-', '--json'], '<!-- retro:start -->\n- **Friction:** none\n<!-- retro:end -->')
    assert.equal(r.status, 1)
    assert.equal(JSON.parse(r.stdout).message, 'stdin: retrospective: no "Review cost" line in the block')
  })

  test("--pr reads that pull request with gh; with neither, the current branch's", () => {
    const body = '<!-- retro:start -->\n- **Friction:**\n- **Review cost:** none\n<!-- retro:end -->'
    gh(JSON.stringify({ number: 171, body, headRefName: 'feat/171/x' }))
    const r = lntt(['check', 'body', '--pr', '171'])
    assert.equal(r.status, 1)
    assert.match(r.stdout, /FAIL +body\/retrospective — pull request #171: retrospective: "Friction" is empty/)
    assert.equal(ghArgs(), 'pr view 171 --json number,body,headRefName\n')
    assert.equal(lntt(['check', 'body']).status, 1)
    assert.equal(ghArgs(), 'pr view --json number,body,headRefName\n')
  })

  test('a gh that fails is a check that cannot run: one line, exit 1, no stack', () => {
    gh('', 1)
    const r = lntt(['check', 'body'])
    assert.equal(r.status, 1)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /^lntt: error: gh pr view --json number,body,headRefName failed\n$/)
  })

  function bodyResults(args: string[]) {
    const r = lntt([...args, '--json'])
    return r.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.area === 'body')
      .map(({ check, status, path, message }) => ({ check, status, path, message }))
  }

  function template(text: string, path = '.github/pull_request_template.md'): void {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), text)
  }

  const BLOCK = '## 🔁 Retro\n<!-- retro:start -->\n- **Friction:**\n- **Review cost:**\n<!-- retro:end -->\n'

  test('lntt check alone does not run the retrospective check, and says so; the template check runs', () => {
    template(`## Why\n\n${BLOCK}`)
    assert.deepEqual(bodyResults(['check']), [
      {
        check: 'retrospective',
        status: 'NOT RUN',
        path: null,
        message: 'no pull request body given: pnpm exec lntt check body [--pr <n> | -]',
      },
      {
        check: 'template',
        status: 'PASS',
        path: '.github/pull_request_template.md',
        message: 'the retrospective block is the one lntt pr block prints',
      },
    ])
  })

  test('template: a block that differs from the configuration fails, with the fix', () => {
    template(BLOCK.replace('- **Review cost:**\n', ''))
    assert.deepEqual(bodyResults(['check', 'body', 'template']), [
      {
        check: 'template',
        status: 'FAIL',
        path: '.github/pull_request_template.md',
        message:
          'the retrospective block differs from the configuration: replace it with what pnpm exec lntt pr block prints',
      },
    ])
    template('## Why\n')
    assert.match(bodyResults(['check', 'body', 'template'])[0].message, /no retrospective block/)
  })

  test('template: at delivery.pullRequest.template, and NOT RUN when there is none', () => {
    assert.deepEqual(bodyResults(['check', 'body', 'template']), [
      {
        check: 'template',
        status: 'NOT RUN',
        path: '.github/pull_request_template.md',
        message: 'no pull request template',
      },
    ])
    const retrospective = { heading: '🔁 Retro', lines: ['Friction', 'Review cost'] }
    writeFileSync(
      join(repo, '.agents/config.jsonc'),
      JSON.stringify({ delivery: { pullRequest: { template: 'docs/pr.md', retrospective } } }),
    )
    template(BLOCK, 'docs/pr.md')
    assert.equal(bodyResults(['check', 'body', 'template'])[0].status, 'PASS')
  })

  test('- checks only the body given, not the template', () => {
    template('no block')
    const filled = '<!-- retro:start -->\n- **Friction:** none\n- **Review cost:** none\n<!-- retro:end -->'
    const r = lntt(['check', 'body', '-'], filled)
    assert.equal(r.status, 0, r.stdout)
  })

  test('usage errors exit 2 and run no gh', () => {
    gh('unused')
    for (const args of [
      ['check', 'body', '--pr', 'abc'],
      ['check', 'body', '-', '--pr', '3'],
      ['check', 'body', 'foo'],
      ['check', 'body', 'template', '--pr', '3'],
      ['check', 'body', '-', '-'],
      ['check', 'body', '--prr', '3'],
      ['check', 'tests', '--pr', '3'],
    ]) {
      assert.equal(lntt(args).status, 2, args.join(' '))
    }
    assert.equal(existsSync(join(tmp, 'gh-args')), false)
  })
})
