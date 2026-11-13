// The candidate following its base against a real git: a bare remote, a clone, and the
// automation's steps on Effect over the follow's typed git operations on that clone and the
// machine's file system (src/ci/candidate.ts); gh answers from a record. What needs no real
// git is src/ci/candidate.spec.ts's.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import * as NodeFileSystem from '@effect/platform-node-shared/NodeFileSystem'
import type { CandidateConfig } from '../../src/ci/candidate.ts'
import { follow as followSteps } from '../../src/ci/candidate-steps.ts'
import type { GitResult } from '../../src/git/git.ts'
import { dryGh, type Gh, type Git, goOn, type Run, runOf } from '../../src/testing/candidate.ts'
import { git, write } from './helpers.ts'

// A git that must not be called: the compare read says there is nothing to do.
const noGit = (): Git => ({
  run: (args) => {
    throw new Error(`unexpected git ${args.join(' ')}`)
  },
  push: (args) => {
    throw new Error(`unexpected git push ${args.join(' ')}`)
  },
})

const follow = (r: Run) => goOn(followSteps(runOf(r)), r, NodeFileSystem.layer)

const config: CandidateConfig = {
  base: 'main',
  prefix: 'candidate/',
  hotfix: { prefix: 'hotfix/', label: 'hotfix' },
  status: { inRelease: 'In release', done: 'Done' },
  retrospective: '## 🔁 Retro\n<!-- retro:start -->\n- **Friction:**\n<!-- retro:end -->\n',
  automated: [{ author: 'dependabot[bot]', branch: 'dependabot/', runs: 'after-approval', ci: 'full' }],
}

// A gh double: reads answered from `answers` by the first key the command line
// contains (a string as is, anything else as JSON), writes recorded.
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
      if (args[1] === 'create') return 'https://github.com/o/r/pull/42'
      if (args.includes('.sha')) return 'c0ffee'
      return ''
    },
  }
}

const silent = () => {}

const node = (number: number, fields = {}) => ({
  number,
  baseRefName: 'main',
  headRefName: `feat/${number}/x`,
  author: { login: 'someone' },
  labels: { nodes: [] },
  timelineItems: { nodes: [] },
  ...fields,
})

const run = (gh: Gh, c: CandidateConfig = config): Run => ({ gh, repo: 'o/r', config: c, log: silent })

describe('follow', () => {
  const IDENTITY = {
    GIT_AUTHOR_NAME: 'bot',
    GIT_AUTHOR_EMAIL: 'bot@example.com',
    GIT_COMMITTER_NAME: 'bot',
    GIT_COMMITTER_EMAIL: 'bot@example.com',
  }

  // A bare remote with `main` and `candidate/4` (the empty opening commit, then a
  // feature), `main` moved by a hotfix after the candidate opened, and a clone of it:
  // the runner's checkout. `conflict` makes the hotfix and the feature edit one file.
  function setup({ conflict = false } = {}) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-follow-')))
    const remote = join(dir, 'remote.git')
    const seed = join(dir, 'seed')
    const clone = join(dir, 'clone')
    git(dir, 'init', '-q', '--bare', '-b', 'main', remote)
    git(dir, 'init', '-q', '-b', 'main', seed)
    write(seed, { 'a.txt': 'one\n' })
    git(seed, 'add', '-A')
    git(seed, 'commit', '-q', '-m', 'init')
    git(seed, 'switch', '-q', '-c', 'candidate/4')
    git(seed, 'commit', '-q', '--allow-empty', '-m', 'chore: open candidate 4')
    write(seed, conflict ? { 'a.txt': 'feature\n' } : { 'b.txt': 'feature\n' })
    git(seed, 'add', '-A')
    git(seed, 'commit', '-q', '-m', 'feat: b')
    const oldHead = git(seed, 'rev-parse', 'HEAD')
    git(seed, 'switch', '-q', 'main')
    write(seed, conflict ? { 'a.txt': 'hotfix\n' } : { 'c.txt': 'hotfix\n' })
    git(seed, 'add', '-A')
    git(seed, 'commit', '-q', '-m', 'fix: hotfix')
    const base = git(seed, 'rev-parse', 'HEAD')
    git(seed, 'remote', 'add', 'origin', remote)
    git(seed, 'push', '-q', 'origin', 'main', 'candidate/4')
    git(dir, 'clone', '-q', '--no-checkout', remote, clone)
    return { dir, remote, seed, clone, oldHead, base }
  }

  type Setup = ReturnType<typeof setup>

  function answers(s: Setup, { prsInto = [] as number[], behindBy = 1, comments = {} as Record<number, string> } = {}) {
    return {
      '--state open': [{ number: 40, headRefName: 'candidate/4', body: '', headRefOid: s.oldHead }],
      'compare/main...candidate/4': { behindBy, base: s.base },
      'api graphql': prsInto.map((n) => node(n, { baseRefName: 'candidate/4' })),
      'issues/40/comments': comments[40] ?? '',
      ...Object.fromEntries(prsInto.map((n) => [`issues/${n}/comments`, comments[n] ?? ''])),
    }
  }

  // The real git on the clone, its pushes recorded; `before` runs ahead of a push. In a dry run the
  // push is printed, as lntt ci candidate --dry-run prints it.
  function recordingGit(s: Setup, { dryRun = false, log = silent as (l: string) => void, before = () => {} } = {}) {
    const env = { ...process.env, ...IDENTITY }
    const real = (args: string[]): GitResult => {
      const result = spawnSync('git', args, { cwd: s.clone, env, encoding: 'utf8' })
      if (result.error) throw result.error
      return { status: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr }
    }
    const pushes: string[][] = []
    const calls: string[][] = []
    const seam: Git & { pushes: string[][]; calls: string[][] } = {
      pushes,
      calls,
      run: (args) => {
        calls.push(args)
        return real(args)
      },
      push: (args) => {
        before()
        pushes.push(args)
        if (dryRun) {
          log(`[dry-run] git push ${args.join(' ')}`)
          return { status: 0, stderr: '' }
        }
        return real(['-c', 'core.hooksPath=/dev/null', 'push', ...args])
      },
    }
    return seam
  }

  const remoteHead = (s: Setup) => git(s.remote, 'rev-parse', 'refs/heads/candidate/4')

  test('nobody on the candidate: its commits are rebased on the base, the empty one kept, with a lease', async (t) => {
    const s = setup()
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    const gh = fakeGh(answers(s))
    const g = recordingGit(s)
    const result = await follow({ ...run(gh), git: g })
    const head = remoteHead(s)
    assert.equal(result.outcome, 'updated')
    assert.equal(result.head, head)
    assert.notEqual(head, s.oldHead)
    assert.equal(git(s.remote, 'rev-list', '--merges', `${s.base}..${head}`), '')
    assert.deepEqual(git(s.remote, 'log', '--format=%s', `${s.base}..${head}`).split('\n'), [
      'feat: b',
      'chore: open candidate 4',
    ])
    assert.equal(git(s.remote, 'rev-parse', `${head}~2`), s.base)
    assert.deepEqual(g.pushes, [
      [`--force-with-lease=refs/heads/candidate/4:${s.oldHead}`, 'origin', `${head}:refs/heads/candidate/4`],
    ])
    assert.equal(gh.writes.length, 1)
    assert.equal(gh.writes[0].args, 'pr comment 40 --repo o/r --body-file -')
    const body = gh.writes[0].input ?? ''
    assert.ok(body.includes(`<!-- candidate:followed:${head} -->`))
    assert.match(body, new RegExp(`${s.base.slice(0, 8)}`))
    assert.match(body, /rebased/)
    assert.match(body, /no pull request is open into it/)
    assert.ok(body.includes(s.oldHead.slice(0, 8)) && body.includes(head.slice(0, 8)))
    assert.match(body, /pnpm ci:local/)
    assert.equal(git(s.clone, 'worktree', 'list').split('\n').length, 1)
  })

  test("the clone's hooks do not run on the automation's rebase and push", async (t) => {
    const s = setup()
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    // Hooks that refuse everything: a project's pre-push or pre-rebase on the machine.
    for (const hook of ['pre-push', 'pre-rebase', 'post-checkout']) {
      write(s.clone, { [`.git/hooks/${hook}`]: '#!/bin/sh\nexit 1\n' })
      chmodSync(join(s.clone, `.git/hooks/${hook}`), 0o755)
    }
    const result = await follow({ ...run(fakeGh(answers(s))), git: recordingGit(s) })
    assert.equal(result.outcome, 'updated')
    assert.equal(remoteHead(s), result.head)
  })

  test('pull requests on the candidate: the base is merged into it, no force, and each is told', async (t) => {
    const s = setup()
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    const gh = fakeGh(answers(s, { prsInto: [12] }))
    const g = recordingGit(s)
    const result = await follow({ ...run(gh), git: g })
    const head = remoteHead(s)
    assert.equal(result.outcome, 'updated')
    assert.equal(git(s.remote, 'rev-list', '--parents', '-n', '1', head), `${head} ${s.oldHead} ${s.base}`)
    assert.match(git(s.remote, 'log', '-1', '--format=%B', head), /^Merge main into candidate\/4\n\n.*main at /)
    assert.ok(git(s.remote, 'log', '-1', '--format=%B', head).includes(s.base))
    assert.deepEqual(g.pushes, [['origin', `${head}:refs/heads/candidate/4`]])
    assert.deepEqual(
      gh.writes.map((w) => w.args),
      ['pr comment 40 --repo o/r --body-file -', 'pr comment 12 --repo o/r --body-file -'],
    )
    assert.match(gh.writes[0].input ?? '', /merged/)
    assert.match(gh.writes[0].input ?? '', /#12 is open into it/)
    assert.ok((gh.writes[1].input ?? '').includes(`<!-- candidate:followed:${head} -->`))
    assert.match(gh.writes[1].input ?? '', /merge or (a )?rebase of `candidate\/4`/)
  })

  for (const [path, prsInto] of [
    ['rebase', []],
    ['merge', [12]],
  ] as const) {
    test(`a conflict in the ${path} path pushes nothing and names the file on the candidate`, async (t) => {
      const s = setup({ conflict: true })
      t.after(() => rmSync(s.dir, { recursive: true, force: true }))
      const gh = fakeGh(answers(s, { prsInto: [...prsInto] }))
      const lines: string[] = []
      const g = recordingGit(s)
      const result = await follow({ ...run(gh), log: (l) => lines.push(l), git: g })
      assert.equal(result.outcome, 'conflict')
      assert.deepEqual(result.files, ['a.txt'])
      assert.equal(remoteHead(s), s.oldHead)
      assert.deepEqual(g.pushes, [])
      assert.deepEqual(
        gh.writes.map((w) => w.args),
        ['pr comment 40 --repo o/r --body-file -'],
      )
      const body = gh.writes[0].input ?? ''
      assert.ok(body.includes(`<!-- candidate:follow:${s.base}:${s.oldHead} -->`))
      assert.match(body, /`a\.txt`/)
      assert.match(body, /git switch candidate\/4/)
      assert.match(body, /git merge origin\/main/)
      assert.match(body, /An admin brings it up to date/)
      assert.ok(lines.some((l) => l.startsWith('::warning title=Candidate not updated::candidate/4')))
      assert.equal(git(s.clone, 'worktree', 'list').split('\n').length, 1)
    })
  }

  test('a candidate moved after the read: the lease refuses, nothing is overwritten, the candidate is told', async (t) => {
    const s = setup()
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    let moved = ''
    const g = recordingGit(s, {
      before: () => {
        git(s.seed, 'switch', '-q', 'candidate/4')
        git(s.seed, 'commit', '-q', '--allow-empty', '-m', 'feat: pushed meanwhile')
        git(s.seed, 'push', '-q', 'origin', 'candidate/4')
        moved = git(s.seed, 'rev-parse', 'HEAD')
      },
    })
    const gh = fakeGh(answers(s))
    const lines: string[] = []
    const result = await follow({ ...run(gh), log: (l) => lines.push(l), git: g })
    assert.equal(result.outcome, 'refused')
    assert.equal(remoteHead(s), moved)
    assert.equal(gh.writes.length, 1)
    const body = gh.writes[0].input ?? ''
    assert.ok(body.includes(`<!-- candidate:follow:${s.base}:${s.oldHead} -->`))
    assert.match(body, /refused/)
    assert.match(body, /stale info|rejected/)
    assert.match(body, /An admin brings it up to date/)
    assert.ok(lines.some((l) => l.startsWith('::warning title=Candidate not updated::')))
  })

  test('a comment already written is not written again', async (t) => {
    const s = setup({ conflict: true })
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    const marker = `<!-- candidate:follow:${s.base}:${s.oldHead} -->`
    const gh = fakeGh(answers(s, { comments: { 40: JSON.stringify({ id: 1, body: `${marker}\nearlier` }) } }))
    const result = await follow({ ...run(gh), git: recordingGit(s) })
    assert.equal(result.outcome, 'conflict')
    assert.deepEqual(gh.writes, [])
  })

  test('the base already an ancestor: no git call, nothing written', async (t) => {
    const s = setup()
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    const gh = fakeGh(answers(s, { behindBy: 0 }))
    const g = recordingGit(s)
    const result = await follow({ ...run(gh), git: g })
    assert.equal(result.path, 'none')
    assert.deepEqual(g.calls, [])
    assert.deepEqual(g.pushes, [])
    assert.deepEqual(gh.writes, [])
  })

  test('the base already an ancestor: the pull requests are not read', async () => {
    const gh = fakeGh({
      '--state open': [{ number: 40, headRefName: 'candidate/4', body: '', headRefOid: 'a'.repeat(40) }],
      'compare/main...candidate/4': { behindBy: 0, base: 'b'.repeat(40) },
    })
    const result = await follow({ ...run(gh), git: noGit() })
    assert.deepEqual([result.path, result.outcome], ['none', 'none'])
  })

  test('a comment that fails after the push is a warning: the candidate is updated, the others are told', async (t) => {
    const s = setup()
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    const base = fakeGh(answers(s, { prsInto: [12, 15] }))
    const gh: typeof base = {
      ...base,
      write: (args, input) => {
        if (args.join(' ') === 'pr comment 12 --repo o/r --body-file -') throw new Error('HTTP 502\nbad gateway')
        return base.write(args, input)
      },
    }
    const lines: string[] = []
    const result = await follow({ ...run(gh), log: (l) => lines.push(l), git: recordingGit(s) })
    assert.equal(result.outcome, 'updated')
    assert.equal(result.head, remoteHead(s))
    assert.deepEqual(
      base.writes.map((w) => w.args),
      ['pr comment 40 --repo o/r --body-file -', 'pr comment 15 --repo o/r --body-file -'],
    )
    assert.ok(
      lines.includes(
        `::warning title=Candidate updated, comment not written::candidate/4 is at ${result.head?.slice(0, 8)}; the comment on #12 failed (gh pr comment failed: HTTP 502 bad gateway)`,
      ),
      lines.join('\n'),
    )
  })

  test('no candidate open: nothing read beyond the list', async () => {
    const gh = fakeGh({ '--state open': [] })
    const result = await follow({ ...run(gh), git: noGit() })
    assert.deepEqual([result.path, result.reason], ['none', 'no candidate open'])
  })

  test('someone pushed to the candidate between the read and the fetch: nothing pushed, nothing written', async (t) => {
    const s = setup()
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    git(s.seed, 'switch', '-q', 'candidate/4')
    git(s.seed, 'commit', '-q', '--allow-empty', '-m', 'feat: later')
    git(s.seed, 'push', '-q', 'origin', 'candidate/4')
    const gh = fakeGh(answers(s))
    const g = recordingGit(s)
    const result = await follow({ ...run(gh), git: g })
    assert.equal(result.outcome, 'moved-meanwhile')
    assert.deepEqual(g.pushes, [])
    assert.deepEqual(gh.writes, [])
  })

  test('a dry run computes the new head locally and pushes nothing', async (t) => {
    const s = setup()
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    const lines: string[] = []
    const log = (l: string) => lines.push(l)
    const gh = dryGh(fakeGh(answers(s)), log)
    const result = await follow({ ...run(gh), log, git: recordingGit(s, { dryRun: true, log }) })
    assert.equal(result.outcome, 'updated')
    assert.equal(remoteHead(s), s.oldHead)
    assert.ok(lines.includes('candidate: follow main: main moved and no pull request is open into candidate/4: rebase'))
    assert.ok(
      lines.some((l) =>
        l.startsWith(`[dry-run] git push --force-with-lease=refs/heads/candidate/4:${s.oldHead} origin ${result.head}`),
      ),
    )
    assert.ok(lines.some((l) => l.startsWith('[dry-run] gh pr comment 40')))
  })

  test('a shallow clone is unshallowed, then the candidate is rebased', async (t) => {
    const s = setup()
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    // A file:// URL, so the depth is honoured.
    const shallow = join(s.dir, 'shallow')
    git(s.dir, 'clone', '-q', '--no-checkout', '--depth', '1', `file://${s.remote}`, shallow)
    assert.equal(git(shallow, 'rev-parse', '--is-shallow-repository'), 'true')
    const gh = fakeGh(answers(s))
    const result = await follow({ ...run(gh), git: recordingGit({ ...s, clone: shallow }) })
    assert.equal(result.outcome, 'updated')
    const head = remoteHead(s)
    assert.equal(result.head, head)
    assert.equal(git(s.remote, 'rev-parse', `${head}~2`), s.base)
    assert.equal(git(shallow, 'rev-parse', '--is-shallow-repository'), 'false')
  })

  test('the merge path tells the candidate and every pull request into it, none into the base', async (t) => {
    const s = setup()
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    const gh = fakeGh({
      ...answers(s, { prsInto: [15, 12] }),
      'api graphql': [
        node(15, { baseRefName: 'candidate/4' }),
        node(20, { baseRefName: 'main' }),
        node(12, { baseRefName: 'candidate/4' }),
      ],
      'issues/20/comments': '',
    })
    const result = await follow({ ...run(gh), git: recordingGit(s) })
    assert.equal(result.path, 'merge')
    assert.equal(result.outcome, 'updated')
    assert.match(result.reason, /#12, #15 are open into candidate\/4/)
    assert.deepEqual(
      gh.writes.map((w) => w.args),
      [
        'pr comment 40 --repo o/r --body-file -',
        'pr comment 12 --repo o/r --body-file -',
        'pr comment 15 --repo o/r --body-file -',
      ],
    )
  })

  test('a pull request open on the base only does not stand on the candidate: rebase', async (t) => {
    const s = setup()
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    const gh = fakeGh({ ...answers(s), 'api graphql': [node(20, { baseRefName: 'main' })] })
    const g = recordingGit(s)
    const result = await follow({ ...run(gh), git: g })
    assert.equal(result.path, 'rebase')
    assert.equal(result.outcome, 'updated')
    assert.ok(g.pushes[0]?.[0]?.startsWith('--force-with-lease='))
    assert.deepEqual(
      gh.writes.map((w) => w.args),
      ['pr comment 40 --repo o/r --body-file -'],
    )
  })

  test('a base the fetch did not bring: nothing pushed, nothing written', async (t) => {
    const s = setup()
    t.after(() => rmSync(s.dir, { recursive: true, force: true }))
    const gh = fakeGh({ ...answers(s), 'compare/main...candidate/4': { behindBy: 1, base: 'f'.repeat(40) } })
    const g = recordingGit(s)
    const result = await follow({ ...run(gh), git: g })
    assert.equal(result.outcome, 'moved-meanwhile')
    assert.deepEqual(g.pushes, [])
    assert.deepEqual(gh.writes, [])
  })

  test('a rebase that fails with no file in conflict throws, naming git rebase', async () => {
    const oldHead = 'a'.repeat(40)
    const base = 'b'.repeat(40)
    const gh = fakeGh({
      '--state open': [{ number: 40, headRefName: 'candidate/4', body: '', headRefOid: oldHead }],
      'compare/main...candidate/4': { behindBy: 1, base },
      'api graphql': [],
    })
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' })
    const fake: Git = {
      run: (args) => {
        const line = args.join(' ')
        if (line.includes('--is-shallow-repository')) return ok('false')
        if (line.includes('refs/remotes/origin/candidate/4')) return ok(oldHead)
        if (/ rebase --keep-empty /.test(` ${line} `)) {
          return { status: 1, stdout: '', stderr: 'fatal: no identity\n' }
        }
        return ok()
      },
      push: (args) => {
        throw new Error(`unexpected git push ${args.join(' ')}`)
      },
    }
    await assert.rejects(follow({ ...run(gh), git: fake }), /git rebase failed: fatal: no identity/)
    assert.deepEqual(gh.writes, [])
  })
})
