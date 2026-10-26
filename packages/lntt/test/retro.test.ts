import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { type CandidateConfig, type Comment, type Gh, retrospectiveComment } from '../src/ci/candidate.ts'
import {
  appendRetro,
  checkBody,
  findLabel,
  retroComment,
  retrospectiveBlock,
  retrospectiveRules,
} from '../src/pull-request.ts'
import { retroAdd } from '../src/retro.ts'

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

  test('a placeholder comment across lines, or left open, is no value either', () => {
    for (const placeholder of ['- **Friction:** <!--\n  what was hard\n  -->', '- **Friction:** <!-- what was hard']) {
      const text = EMPTY.replace('- **Friction:**', placeholder)
      assert.match(appendRetro(text, 'Friction', 'x', RULES), /- \*\*Friction:\*\* x\n- \*\*To automate/)
    }
  })

  test('none on the label line with sub-bullets below: none goes, the sub-bullets stay, one more', () => {
    const text = EMPTY.replace('- **Friction:**', '- **Friction:** none\n  - first')
    assert.match(appendRetro(text, 'Friction', 'x', RULES), /- \*\*Friction:\*\*\n {2}- first\n {2}- x\n/)
  })

  test('none on the label line with free text and a placeholder below: none goes, the text stays', () => {
    const text = EMPTY.replace('- **Friction:**', '- **Friction:** none\n  the review stalled\n  <!-- more -->')
    assert.match(
      appendRetro(text, 'Friction', 'x', RULES),
      /- \*\*Friction:\*\*\n {2}the review stalled\n {2}<!-- more -->\n {2}- x\n- \*\*To/,
    )
  })

  test('an empty label line with a value on the lines below: the item after them', () => {
    const text = EMPTY.replace('- **Friction:**', '- **Friction:**\n  the review stalled\n  twice')
    assert.match(
      appendRetro(text, 'Friction', 'x', RULES),
      /:\*\*\n {2}the review stalled\n {2}twice\n {2}- x\n- \*\*To/,
    )
  })

  test('a value on the label line with more below: the value becomes the first sub-bullet', () => {
    const text = EMPTY.replace('- **Friction:**', '- **Friction:** first\n  - second')
    assert.match(appendRetro(text, 'Friction', 'third', RULES), /:\*\*\n {2}- first\n {2}- second\n {2}- third\n/)
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
// returned as is, anything else as JSON), writes recorded. Comments are state: a PATCH
// changes the comment in its `issues/<n>/comments` answer and `pr comment <n>` adds one,
// unless `lost` drops the write (another append won the race).
function fakeGh(
  answers: Record<string, unknown>,
  { lost = 0 } = {},
): Gh & { writes: Array<{ args: string; input?: string }> } {
  const writes: Array<{ args: string; input?: string }> = []
  let drop = lost
  const edit = (key: string, change: (all: Comment[]) => Comment[]) => {
    const all = String(answers[key] ?? '')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Comment)
    answers[key] = lines(...change(all))
  }
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
      if (drop-- > 0) return ''
      const patched = /issues\/comments\/(\d+)$/.exec(args[3] ?? '')
      if (args[2] === 'PATCH' && patched) {
        const body = JSON.parse(input ?? '').body as string
        for (const key of Object.keys(answers).filter((k) => /^issues\/\d+\/comments$/.test(k))) {
          edit(key, (all) => all.map((c) => (c.id === Number(patched[1]) ? { ...c, body } : c)))
        }
      }
      if (args[0] === 'pr' && args[1] === 'comment') {
        edit(`issues/${args[2]}/comments`, (all) => [...all, { id: 100 + all.length, body: input ?? '' }])
      }
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
    assert.equal(gh.writes.length, 1, 'read again, the item is there: one write')
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

  test('an append another writer dropped is written again; one never kept is refused', () => {
    const comment = { 'issues/80/comments': lines({ id: 7, body: EMPTY }) }
    const once = fakeGh({ ...open, ...comment }, { lost: 1 })
    retroAdd({ gh: once, repo: 'o/r', config, rules: RULES }, { label: 'friction', item: 'x' })
    assert.equal(once.writes.length, 2)
    const never = fakeGh({ ...open, ...comment }, { lost: 9 })
    assert.throws(
      () => retroAdd({ gh: never, repo: 'o/r', config, rules: RULES }, { label: 'friction', item: 'x' }),
      /not in the retrospective comment of #80 after 3 writes/,
    )
    assert.equal(never.writes.length, 3)
  })

  test('a sub-bullet append another writer dropped is written again', () => {
    const body = EMPTY.replace('- **Friction:**', '- **Friction:** first')
    const gh = fakeGh({ ...open, 'issues/80/comments': lines({ id: 7, body }) }, { lost: 1 })
    retroAdd({ gh, repo: 'o/r', config, rules: RULES }, { label: 'friction', item: 'second' })
    assert.equal(gh.writes.length, 2)
    assert.match(JSON.parse(gh.writes[1]?.input ?? '').body, /:\*\*\n {2}- first\n {2}- second\n/)
  })

  test('an item already in the comment, dropped once, is still written again', () => {
    const body = EMPTY.replace('- **Friction:**', '- **Friction:** x')
    const gh = fakeGh({ ...open, 'issues/80/comments': lines({ id: 7, body }) }, { lost: 1 })
    retroAdd({ gh, repo: 'o/r', config, rules: RULES }, { label: 'friction', item: 'x' })
    assert.equal(gh.writes.length, 2)
  })

  test('two comments created at once: the item goes into the first, the retrospective one', () => {
    let listed = ''
    const gh: Gh & { writes: string[] } = {
      writes: [],
      read: (args) => {
        const line = args.join(' ')
        if (line.includes('issues/80/comments')) return listed
        return JSON.stringify(open['--state open'])
      },
      write: (args, input) => {
        gh.writes.push(args.join(' '))
        if (args[1] === 'comment') listed = lines({ id: 50, body: EMPTY }, { id: 51, body: input ?? '' })
        if (args[2] === 'PATCH') listed = lines({ id: 50, body: JSON.parse(input ?? '').body }, { id: 51, body: '' })
        return ''
      },
    }
    const result = retroAdd({ gh, repo: 'o/r', config, rules: RULES }, { label: 'friction', item: 'x' })
    assert.equal(result.created, false, 'the item is in the comment another run created')
    assert.deepEqual(gh.writes, [
      'pr comment 80 --repo o/r --body-file -',
      'api -X PATCH repos/o/r/issues/comments/50 --input -',
    ])
  })

  test('a comment gone between two passes: the new one is judged on its own count', () => {
    const had = EMPTY.replace('- **Friction:**', '- **Friction:** x')
    const reads = [lines({ id: 7, body: had }), '']
    let listed = ''
    const gh: Gh & { writes: string[] } = {
      writes: [],
      read: (args) => {
        if (!args.join(' ').includes('issues/80/comments')) return JSON.stringify(open['--state open'])
        return reads.length > 0 ? (reads.shift() as string) : listed
      },
      write: (args, input) => {
        gh.writes.push(args.join(' '))
        if (args[1] === 'comment') listed = lines({ id: 9, body: input ?? '' })
        return ''
      },
    }
    const result = retroAdd({ gh, repo: 'o/r', config, rules: RULES }, { label: 'friction', item: 'x' })
    assert.equal(result.created, true)
    assert.deepEqual(gh.writes, [
      'api -X PATCH repos/o/r/issues/comments/7 --input -',
      'pr comment 80 --repo o/r --body-file -',
    ])
  })

  test('a dry run writes once and reads nothing back', () => {
    const gh = fakeGh({ ...open, 'issues/80/comments': lines({ id: 7, body: EMPTY }) }, { lost: 9 })
    retroAdd({ gh, repo: 'o/r', config, rules: RULES, dryRun: true }, { label: 'friction', item: 'x' })
    assert.equal(gh.writes.length, 1)
  })

  test('a comment with the start marker and no end marker is refused, nothing written', () => {
    const gh = fakeGh({
      ...open,
      'issues/80/comments': lines({ id: 7, body: '<!-- retro:start -->\n- **Friction:**' }),
    })
    assert.throws(
      () => retroAdd({ gh, repo: 'o/r', config, rules: RULES }, { label: 'friction', item: 'x' }),
      /no <!-- retro:start --> … <!-- retro:end --> block/,
    )
    assert.deepEqual(gh.writes, [])
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

  test('without GITHUB_REPOSITORY the repository comes from gh repo view', () => {
    retroGh()
    const r = lntt(['retro', 'add', '--label', 'friction', 'x'], { GITHUB_REPOSITORY: '' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(readFileSync(join(tmp, 'gh-args'), 'utf8'), /^api -X PATCH repos\/me\/mine\/issues\/comments\/2 /m)
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
