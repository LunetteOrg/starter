import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Comment } from '../src/ci/candidate.ts'
import { retrospectiveBlock, retrospectiveRules } from '../src/pull-request.ts'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/lntt.ts')

const EMPTY = retrospectiveBlock(retrospectiveRules({}))

const lines = (...comments: Comment[]) => comments.map((c) => JSON.stringify(c)).join('\n')

// lntt check body on a candidate, and the main paths of lntt retro add, through the CLI as a process
// with a gh on PATH; the rest of lntt retro add is in src/retro/command.spec.ts, the block's labels
// and its append in src/pull-request.spec.ts.
describe('lntt retro add and lntt check body on a candidate', () => {
  let tmp: string
  let stubs: string
  let repo: string

  function lntt(args: string[], env: Record<string, string> = {}) {
    const vars: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${stubs}:${process.env.PATH}`,
      GITHUB_REPOSITORY: 'o/r',
      ...env,
    }
    if (vars.GITHUB_REPOSITORY === '') delete vars.GITHUB_REPOSITORY
    return spawnSync(process.execPath, [BIN, ...args], { cwd: repo, encoding: 'utf8', env: vars })
  }

  // A fake gh: each call's arguments appended to gh-args; `pr view` prints view.json, the
  // comments call prints comments.jsonl, anything else prints nothing.
  function gh(view: unknown, comments: Comment[]): void {
    writeFileSync(join(tmp, 'view.json'), JSON.stringify(view))
    writeFileSync(join(tmp, 'comments.jsonl'), lines(...comments))
    writeFileSync(
      join(stubs, 'gh'),
      [
        '#!/bin/sh',
        `echo "$*" >> "${join(tmp, 'gh-args')}"`,
        'case "$*" in',
        `  "pr view"*) cat "${join(tmp, 'view.json')}" ;;`,
        `  *"/comments --jq"*) cat "${join(tmp, 'comments.jsonl')}" ;;`,
        'esac',
      ].join('\n'),
    )
    chmodSync(join(stubs, 'gh'), 0o755)
  }

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-retro-')))
    stubs = join(tmp, 'bin')
    repo = join(tmp, 'repo')
    mkdirSync(stubs)
    mkdirSync(join(repo, '.agents'), { recursive: true })
    const retrospective = { lines: ['Friction', 'Rework cause'] }
    writeFileSync(
      join(repo, '.agents/config.jsonc'),
      JSON.stringify({ delivery: { candidate: { prefix: 'candidate/' }, pullRequest: { retrospective } } }),
    )
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  const filled = '<!-- retro:start -->\n- **Friction:** none\n- **Rework cause:** none\n<!-- retro:end -->'
  const empty = '<!-- retro:start -->\n- **Friction:** none\n- **Rework cause:**\n<!-- retro:end -->'

  test('on a candidate, the retrospective comment is checked, not the body', () => {
    gh({ number: 80, body: 'The list.', headRefName: 'candidate/8' }, [
      { id: 1, body: 'Moved.' },
      { id: 2, body: empty },
    ])
    const r = lntt(['check', 'body', '--pr', '80'])
    assert.equal(r.status, 1, r.stderr)
    assert.match(
      r.stdout,
      /FAIL +body\/retrospective — the retrospective comment of candidate #80: retrospective: "Rework cause" is empty/,
    )
    assert.match(
      readFileSync(join(tmp, 'gh-args'), 'utf8'),
      /^pr view 80 --json number,body,headRefName\napi --paginate repos\/\{owner\}\/\{repo\}\/issues\/80\/comments/,
    )
    gh({ number: 80, body: 'The list.', headRefName: 'candidate/8' }, [{ id: 2, body: filled }])
    assert.equal(lntt(['check', 'body', '--pr', '80']).status, 0)
  })

  test('a candidate with no retrospective comment fails', () => {
    gh({ number: 80, body: filled, headRefName: 'candidate/8' }, [{ id: 1, body: 'Moved.' }])
    const r = lntt(['check', 'body'])
    assert.equal(r.status, 1)
    assert.match(
      r.stdout,
      /the comments of candidate #80: retrospective: no <!-- retro:start --> … <!-- retro:end --> block/,
    )
  })

  test('a gh pr view that prints no JSON is a check that cannot run: one line, exit 1', () => {
    gh({}, [])
    writeFileSync(join(tmp, 'view.json'), 'not json')
    const r = lntt(['check', 'body', '--pr', '80'])
    assert.equal(r.status, 1)
    assert.equal(r.stderr, 'lntt: error: gh pr view 80 --json number,body,headRefName printed no JSON\n')
  })

  test('any other pull request is checked on its body, and its comments are not read', () => {
    gh({ number: 81, body: filled, headRefName: 'feat/1/x' }, [])
    const r = lntt(['check', 'body', '--pr', '81'])
    assert.equal(r.status, 0, r.stdout)
    assert.equal(readFileSync(join(tmp, 'gh-args'), 'utf8'), 'pr view 81 --json number,body,headRefName\n')
  })

  // The gh of `lntt retro add`: the open candidate #80, its comment #2, `repo view`, and a
  // PATCH saved to patch.json, which the comments read after it return.
  function retroGh(): void {
    gh({}, [{ id: 2, body: EMPTY }])
    const patch = join(tmp, 'patch.json')
    writeFileSync(
      join(stubs, 'gh'),
      [
        '#!/bin/sh',
        `echo "$*" >> "${join(tmp, 'gh-args')}"`,
        'case "$*" in',
        `  "pr list"*) echo '[{"number":80,"headRefName":"candidate/8","body":""}]' ;;`,
        `  "repo view"*) echo 'me/mine' ;;`,
        `  "api -X PATCH"*) cat > "${patch}" ;;`,
        `  *"/comments --jq"*) if [ -f "${patch}" ]; then jq -c '{id: 2, body}' "${patch}"; else cat "${join(tmp, 'comments.jsonl')}"; fi ;;`,
        'esac',
      ].join('\n'),
    )
  }

  test('lntt retro add edits the open candidate’s comment and says where', () => {
    retroGh()
    const r = lntt(['retro', 'add', '--label', 'rework', 'the', 'squash', 'order'])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, 'retro: added under "Rework cause" on #80.\n')
    const body = JSON.parse(readFileSync(join(tmp, 'patch.json'), 'utf8')).body as string
    assert.match(body, /- \*\*Rework cause:\*\* the squash order/)
    assert.match(readFileSync(join(tmp, 'gh-args'), 'utf8'), /^api -X PATCH repos\/o\/r\/issues\/comments\/2 /m)
  })

  test('--dry-run writes nothing and says what it would add', () => {
    retroGh()
    const r = lntt(['retro', 'add', '--dry-run', '--label', 'friction', 'x'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /^\[dry-run\] gh api -X PATCH repos\/o\/r\/issues\/comments\/2 --input -\n/)
    assert.match(r.stdout, /retro: would add under "Friction" on #80\.\n$/)
    assert.doesNotMatch(readFileSync(join(tmp, 'gh-args'), 'utf8'), /PATCH|pr comment/)
  })

  test('lntt retro: usage errors exit 2, a refusal exits 1 with one line', () => {
    gh({}, [])
    for (const args of [
      ['retro'],
      ['retro', 'list'],
      ['retro', 'add', 'x'],
      ['retro', 'add', '--label', 'friction'],
      ['retro', 'add', '--label', 'friction', '--pr', 'abc', 'x'],
      ['retro', 'add', '--lable', 'friction', 'x'],
    ]) {
      assert.equal(lntt(args).status, 2, args.join(' '))
    }
    const r = lntt(['retro', 'add', '--label', 'cost', 'x'])
    assert.equal(r.status, 1)
    assert.equal(r.stderr, 'lntt retro: no label "cost": one of Friction, Rework cause\n')
  })
})
