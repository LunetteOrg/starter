import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { type CandidateConfig, type Gh, retrospectiveComment } from '../src/ci/candidate.ts'
import { appendRetro, checkBody, findLabel, retrospectiveBlock, retrospectiveRules } from '../src/pull-request.ts'
import { type Comment, retroAdd, retroComment } from '../src/retro.ts'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/lntt.ts')

const RULES = retrospectiveRules({})
const EMPTY = retrospectiveBlock(RULES)

describe('findLabel', () => {
  test('the configured label equal ignoring case, else the only one it starts', () => {
    assert.equal(findLabel(RULES, 'friction'), 'Friction')
    assert.equal(findLabel(RULES, 'to automate'), 'To automate (hook/skill/agent)')
    assert.equal(findLabel(RULES, 'R'), null, 'Rule rediscovered and Rework cause both start with R')
    assert.equal(findLabel(RULES, 'cost'), null)
    assert.equal(findLabel(RULES, ' '), null)
  })
})

describe('appendRetro', () => {
  test('an empty label takes the item on its line; the markers and the other labels stay', () => {
    const next = appendRetro(EMPTY, 'Friction', 'the review did not converge', RULES)
    assert.equal(next, EMPTY.replace('- **Friction:**', '- **Friction:** the review did not converge'))
    assert.deepEqual(
      checkBody(next, RULES).map((p) => p.replace(/"(.+)" is empty.*/, '$1')),
      [
        'retrospective: To automate (hook/skill/agent)',
        'retrospective: Rule rediscovered (→ ADR/AGENTS.md)',
        'retrospective: Rework cause',
      ],
    )
  })

  test('a label with one item gets sub-bullets, the first item kept first', () => {
    const one = appendRetro(EMPTY, 'Friction', 'first', RULES)
    const two = appendRetro(one, 'Friction', 'second', RULES)
    assert.match(two, /- \*\*Friction:\*\*\n {2}- first\n {2}- second\n- \*\*To automate/)
  })

  test('a label with sub-bullets gets one more, after the last one', () => {
    const text = EMPTY.replace('- **Friction:**', '- **Friction:**\n  - first\n  - second')
    const next = appendRetro(text, 'Friction', 'third', RULES)
    assert.match(next, /- \*\*Friction:\*\*\n {2}- first\n {2}- second\n {2}- third\n- \*\*To automate/)
  })

  test('the last label, right above the end marker', () => {
    const next = appendRetro(EMPTY, 'Rework cause', 'the squash order', RULES)
    assert.match(next, /- \*\*Rework cause:\*\* the squash order\n<!-- retro:end -->/)
  })

  test('none and a placeholder comment are replaced by the item', () => {
    const none = EMPTY.replace('- **Friction:**', '- **Friction:** none')
    assert.match(appendRetro(none, 'Friction', 'x', RULES), /- \*\*Friction:\*\* x\n/)
    const placeholder = EMPTY.replace('- **Friction:**', '- **Friction:** <!-- what was hard -->')
    assert.match(appendRetro(placeholder, 'Friction', 'x', RULES), /- \*\*Friction:\*\* x\n/)
  })

  test('text around the block, and CRLF line endings, are kept', () => {
    const text = `Lead.\r\n\r\n${EMPTY.replaceAll('\n', '\r\n')}After.`
    const next = appendRetro(text, 'Friction', 'x', RULES)
    assert.ok(next.startsWith('Lead.\r\n\r\n## 🔁 Retrospective\r\n'))
    assert.ok(next.endsWith('<!-- retro:end -->\r\nAfter.'))
    assert.ok(next.includes('- **Friction:** x\r\n'))
  })

  test('no block, or a block without the label, is refused', () => {
    assert.throws(
      () => appendRetro('no block', 'Friction', 'x', RULES),
      /no <!-- retro:start --> … <!-- retro:end --> block/,
    )
    const without = EMPTY.replace('- **Friction:**\n', '')
    assert.throws(() => appendRetro(without, 'Friction', 'x', RULES), /no "Friction" line in the block/)
  })
})

describe('retroComment', () => {
  test('the first comment holding the start marker on a line of its own', () => {
    const all: Comment[] = [
      { id: 1, body: 'Moved onto candidate/8.' },
      { id: 2, body: 'The block sits between `<!-- retro:start -->` and its end.' },
      { id: 3, body: EMPTY },
      { id: 4, body: EMPTY },
    ]
    assert.equal(retroComment(all)?.id, 3)
    assert.equal(retroComment(all.slice(0, 2)), null)
  })
})

const config: CandidateConfig = {
  base: 'main',
  prefix: 'candidate/',
  hotfix: { prefix: 'hotfix/', label: 'hotfix' },
  status: { inRelease: 'In release', done: 'Done' },
  retrospective: EMPTY,
}

// A gh double: reads answered by the first key the command line contains (a string is
// returned as is, anything else as JSON), writes recorded.
function fakeGh(answers: Record<string, unknown>): Gh & { writes: Array<{ args: string; input?: string }> } {
  const writes: Array<{ args: string; input?: string }> = []
  return {
    writes,
    read: (args) => {
      const line = args.join(' ')
      const key = Object.keys(answers).find((k) => line.includes(k))
      if (key === undefined) throw new Error(`unexpected read: ${line}`)
      const answer = answers[key]
      return typeof answer === 'string' ? answer : JSON.stringify(answer)
    },
    write: (args, input) => {
      writes.push({ args: args.join(' '), input })
      return ''
    },
  }
}

const lines = (...comments: Comment[]) => comments.map((c) => JSON.stringify(c)).join('\n')

describe('retroAdd', () => {
  const open = { '--state open': [{ number: 80, headRefName: 'candidate/8', body: '' }] }

  test('appends to the open candidate’s retrospective comment, edited in place', () => {
    const gh = fakeGh({
      ...open,
      'issues/80/comments': lines({ id: 5, body: 'Moved.' }, { id: 7, body: retrospectiveComment(config) }),
    })
    const result = retroAdd({ gh, repo: 'o/r', config, rules: RULES }, { label: 'friction', item: 'a CI run\n failed' })
    assert.deepEqual(result, { pr: 80, label: 'Friction', created: false })
    assert.equal(gh.writes.length, 1)
    assert.equal(gh.writes[0]?.args, 'api -X PATCH repos/o/r/issues/comments/7 --input -')
    const body = JSON.parse(gh.writes[0]?.input ?? '').body as string
    assert.ok(body.startsWith('The retrospective of this candidate'))
    assert.match(body, /- \*\*Friction:\*\* a CI run failed\n- \*\*To automate/)
  })

  test('--pr names the pull request, and no candidate is looked for', () => {
    const gh = fakeGh({ 'issues/12/comments': lines({ id: 9, body: EMPTY }) })
    assert.equal(
      retroAdd({ gh, repo: 'o/r', config: null, rules: RULES }, { pr: 12, label: 'rework', item: 'x' }).pr,
      12,
    )
    assert.equal(gh.writes[0]?.args, 'api -X PATCH repos/o/r/issues/comments/9 --input -')
  })

  test('a candidate with no retrospective comment gets one, with the item', () => {
    const gh = fakeGh({ ...open, 'issues/80/comments': '' })
    const result = retroAdd({ gh, repo: 'o/r', config, rules: RULES }, { label: 'Friction', item: 'x' })
    assert.equal(result.created, true)
    assert.equal(gh.writes[0]?.args, 'pr comment 80 --repo o/r --body-file -')
    assert.equal(gh.writes[0]?.input, appendRetro(retrospectiveComment(config), 'Friction', 'x', RULES))
  })

  test('no open candidate: refused, naming --pr, nothing written', () => {
    const gh = fakeGh({ '--state open': [{ number: 9, headRefName: 'feat/candidate/9', body: '' }] })
    assert.throws(
      () => retroAdd({ gh, repo: 'o/r', config, rules: RULES }, { label: 'friction', item: 'x' }),
      /no open candidate \(candidate\/<N> into main\): give the pull request with --pr <n>/,
    )
    assert.throws(
      () => retroAdd({ gh, repo: 'o/r', config: null, rules: RULES }, { label: 'friction', item: 'x' }),
      /no open candidate \(no delivery.candidate\)/,
    )
    assert.deepEqual(gh.writes, [])
  })

  test('an unknown label or an empty item is refused before gh is called', () => {
    const gh = fakeGh({})
    assert.throws(
      () => retroAdd({ gh, repo: 'o/r', config, rules: RULES }, { label: 'cost', item: 'x' }),
      /no label "cost": one of Friction, To automate/,
    )
    assert.throws(
      () => retroAdd({ gh, repo: 'o/r', config, rules: RULES }, { label: 'friction', item: ' \n' }),
      /empty/,
    )
    assert.deepEqual(gh.writes, [])
  })
})

describe('lntt retro add and lntt check body on a candidate', () => {
  let tmp: string
  let stubs: string
  let repo: string

  function lntt(args: string[]) {
    return spawnSync(process.execPath, [BIN, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, GITHUB_REPOSITORY: 'o/r' },
    })
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

  test('any other pull request is checked on its body, and its comments are not read', () => {
    gh({ number: 81, body: filled, headRefName: 'feat/1/x' }, [])
    const r = lntt(['check', 'body', '--pr', '81'])
    assert.equal(r.status, 0, r.stdout)
    assert.equal(readFileSync(join(tmp, 'gh-args'), 'utf8'), 'pr view 81 --json number,body,headRefName\n')
  })

  test('lntt retro add edits the open candidate’s comment and says where', () => {
    gh({}, [{ id: 2, body: EMPTY }])
    writeFileSync(
      join(stubs, 'gh'),
      readFileSync(join(stubs, 'gh'), 'utf8').replace(
        'esac',
        `  "pr list"*) echo '[{"number":80,"headRefName":"candidate/8","body":""}]' ;;\n  "api -X PATCH"*) cat > "${join(tmp, 'patch.json')}" ;;\nesac`,
      ),
    )
    const r = lntt(['retro', 'add', '--label', 'rework', 'the', 'squash', 'order'])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(r.stdout, 'retro: added under "Rework cause" on #80.\n')
    const body = JSON.parse(readFileSync(join(tmp, 'patch.json'), 'utf8')).body as string
    assert.match(body, /- \*\*Rework cause:\*\* the squash order/)
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
