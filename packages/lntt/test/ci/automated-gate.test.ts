import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { parse } from 'yaml'
import { type Context, evaluate, interpolate } from '../../src/ci/expressions.ts'

// The gate of the bots' pull requests (docs/process/ci.md#automated-pull-requests) is
// shell in two workflows of this repo: ci.yml's first step counts the approvals of the
// head, ci-approval.yml re-runs that ci run on a review. Each test runs the step as
// committed, under bash -eo pipefail as GitHub does, with a fake gh that answers from
// the fixtures and records its calls. Whose approval counts is the reviewer's permission
// on the repository, never the review's author_association: a member whose membership
// is private (GitHub's default) is CONTRIBUTOR to everyone but themselves.

const WORKFLOWS = new URL('../../../../.github/workflows/', import.meta.url)
const REPO = 'acme/app'
const SHA = 'a1b2c3'

interface Step {
  name?: string
  if?: string
  env?: Record<string, string>
  run: string
}

function workflow(file: string) {
  return parse(readFileSync(new URL(file, WORKFLOWS), 'utf8'))
}

function step(file: string, job: string, index: number): Step {
  return workflow(file).jobs[job].steps[index]
}

// The bot comes from the delivery.automated line the step carries (lntt sync writes it
// from the configuration), as the gate reads it: the first `runs: after-approval` entry.
// A copy of the repo whose configuration names another bot runs the same tests.
function bot(s: Step) {
  const entries: { author: string; branch: string; runs: string }[] = JSON.parse(s.env?.AUTOMATED ?? '[]')
  const entry = entries.find((e) => e.runs === 'after-approval')
  assert.ok(entry, `no delivery.automated entry with runs: after-approval in ${s.name}`)
  return { login: entry.author, ref: `${entry.branch}npm_and_yarn/vite-7.0.1` }
}

const FAKE_GH = `#!/bin/bash
# The fake gh: one line per call in $GH_LOG; gh api answers the fixture of its path
# through its --jq filter (raw, as gh prints it), or fails as a missing one does.
echo "$*" >> "$GH_LOG"
if [ "$1" = run ]; then exit 0; fi
path=""; filter="."
shift
while [ $# -gt 0 ]; do
  case $1 in
    --paginate) ;;
    --jq) shift; filter=$1 ;;
    *) path=$1 ;;
  esac
  shift
done
case $path in
  */reviews*) file=reviews.json ;;
  */collaborators/*/permission) user=\${path#*/collaborators/}; file="permission-\${user%/permission}.json" ;;
  */actions/workflows/*) file=runs.json ;;
  *) echo "fake gh: no fixture for $path" >&2; exit 1 ;;
esac
if [ ! -f "$FIXTURES/$file" ]; then echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
jq -r "$filter" "$FIXTURES/$file"
`

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lntt-gate-'))
  writeFileSync(join(dir, 'gh'), FAKE_GH)
  chmodSync(join(dir, 'gh'), 0o755)
  writeFileSync(join(dir, 'env'), '')
  writeFileSync(join(dir, 'calls'), '')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function fixture(name: string, value: unknown) {
  writeFileSync(join(dir, name), JSON.stringify(value))
}

// A reviewer's permission on the repository, as GET collaborators/{user}/permission
// answers it: GitHub's role name, and the legacy permission it folds into.
function permission(user: string, role: 'admin' | 'maintain' | 'write' | 'triage' | 'read' | 'none') {
  const legacy = { admin: 'admin', maintain: 'write', write: 'write', triage: 'read', read: 'read', none: 'none' }[role]
  fixture(`permission-${user}.json`, { permission: legacy, role_name: role, user: { login: user } })
}

// A review as the reviews API lists it. The association is what an anonymous reader
// sees: a private member is CONTRIBUTOR.
function review(user: string, state: string, commit = SHA, association = 'CONTRIBUTOR') {
  return { user: { login: user }, state, commit_id: commit, author_association: association }
}

// The step's env, with its expressions evaluated against the event as GitHub would.
function stepEnv(s: Step, context: Context): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(s.env ?? {})) {
    const out = interpolate(`format('{0}', ${toFormat(String(value))})`, context)
    env[key] = out.known ? out.value : String(value)
  }
  return env
}

// `${{ a }}` → the expression a; plain text → a string literal.
function toFormat(value: string): string {
  const match = value.match(/^\$\{\{\s*(.*?)\s*\}\}$/)
  return match ? match[1] : `'${value.replace(/'/g, "''")}'`
}

function runStep(s: Step, context: Context) {
  const event = join(dir, 'event.json')
  writeFileSync(event, JSON.stringify(context.github && (context.github as { event: unknown }).event))
  const out = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', s.run], {
    encoding: 'utf8',
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      GH_LOG: join(dir, 'calls'),
      FIXTURES: dir,
      GITHUB_EVENT_PATH: event,
      GITHUB_ENV: join(dir, 'env'),
      ...stepEnv(s, context),
    },
  })
  const calls = readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean)
  return { status: out.status, output: out.stdout + out.stderr, calls, env: readFileSync(join(dir, 'env'), 'utf8') }
}

// A pull request of the bot of step s, or of author and ref.
function pullRequest(s: Step, author = bot(s).login, ref = bot(s).ref) {
  return { number: 7, draft: false, user: { login: author }, head: { ref, sha: SHA } }
}

describe("ci.yml's first step: the approval of a bot's pull request", () => {
  const gate = () => step('ci.yml', 'ci', 0)
  const context = (pr = pullRequest(gate())) => ({
    github: { event_name: 'pull_request', repository: REPO, token: 'tok', event: { pull_request: pr } },
  })

  test('is the step that reads the reviews', () => {
    assert.equal(gate().name, 'Automated pull request')
  })

  test('a pull request of no delivery.automated entry passes, and asks nothing', () => {
    const out = runStep(gate(), context(pullRequest(gate(), 'octocat', 'feat/1/x')))
    assert.equal(out.status, 0, out.output)
    assert.deepEqual(out.calls, [])
    assert.equal(out.env, '')
  })

  test("a private member's approval counts: the permission decides, not the association", () => {
    fixture('reviews.json', [review('maintainer', 'APPROVED', SHA, 'CONTRIBUTOR')])
    permission('maintainer', 'maintain')
    const out = runStep(gate(), context())
    assert.equal(out.status, 0, out.output)
    assert.match(out.env, /AUTOMATED_RUNS=after-approval/)
    assert.ok(out.calls.some((c) => c.includes(`repos/${REPO}/collaborators/maintainer/permission`)))
  })

  test('write, maintain and admin count; triage, read and none do not', () => {
    for (const [role, passes] of [
      ['admin', true],
      ['maintain', true],
      ['write', true],
      ['triage', false],
      ['read', false],
      ['none', false],
    ] as const) {
      fixture('reviews.json', [review('someone', 'APPROVED')])
      permission('someone', role)
      const out = runStep(gate(), context())
      assert.equal(out.status === 0, passes, `${role}: ${out.output}`)
      if (!passes) assert.match(out.output, /::error title=CI not run::Approve this pull request's head commit/)
    }
  })

  test('an author_association of OWNER does not count by itself', () => {
    fixture('reviews.json', [review('outsider', 'APPROVED', SHA, 'OWNER')])
    permission('outsider', 'read')
    assert.equal(runStep(gate(), context()).status, 1)
  })

  test("only each reviewer's latest review of the head counts", () => {
    permission('maintainer', 'write')
    fixture('reviews.json', [review('maintainer', 'APPROVED'), review('maintainer', 'CHANGES_REQUESTED')])
    const changes = runStep(gate(), context())
    assert.equal(changes.status, 1)
    // No approver left: no permission is asked, and no warning names an empty reviewer.
    assert.ok(!changes.calls.some((c) => c.includes('/collaborators/')), changes.calls.join('\n'))
    assert.doesNotMatch(changes.output, /::warning/)
    fixture('reviews.json', [review('maintainer', 'APPROVED', 'an-older-head')])
    assert.equal(runStep(gate(), context()).status, 1)
    fixture('reviews.json', [
      review('maintainer', 'CHANGES_REQUESTED'),
      review('maintainer', 'COMMENTED'),
      review('maintainer', 'APPROVED'),
    ])
    assert.equal(runStep(gate(), context()).status, 0)
  })

  test('an approval whose permission the token cannot read does not count, with a warning naming the reviewer', () => {
    fixture('reviews.json', [review('maintainer', 'APPROVED')])
    const alone = runStep(gate(), context())
    assert.equal(alone.status, 1)
    assert.match(alone.output, /::warning title=Approval not counted::.*maintainer/)
    assert.match(alone.output, /::error title=CI not run::/)
    fixture('reviews.json', [review('maintainer', 'APPROVED'), review('admin-user', 'APPROVED')])
    permission('admin-user', 'admin')
    const beside = runStep(gate(), context())
    assert.equal(beside.status, 0, beside.output)
    assert.match(beside.output, /::warning title=Approval not counted::.*maintainer/)
  })
})

describe("ci-approval.yml: a review re-runs the bot's ci run", () => {
  const rerun = () => step('ci-approval.yml', 'rerun', 0)
  const condition = () => workflow('ci-approval.yml').jobs.rerun.if as string
  const context = (state: string, reviewer = 'maintainer', pr = pullRequest(rerun())) => ({
    github: {
      event_name: 'pull_request_review',
      repository: REPO,
      token: 'tok',
      event: {
        pull_request: pr,
        review: { state, user: { login: reviewer }, author_association: 'CONTRIBUTOR' },
      },
    },
  })

  test('the job runs on an approval, a request for changes and a dismissal, whatever the association; not on a comment or a draft', () => {
    for (const [state, runs] of [
      ['approved', true],
      ['changes_requested', true],
      ['dismissed', true],
      ['commented', false],
    ] as const) {
      const out = evaluate(condition(), context(state), { failed: false })
      assert.deepEqual(out, { known: true, value: runs }, state)
    }
    const draft = context('approved', 'maintainer', { ...pullRequest(rerun()), draft: true })
    assert.deepEqual(evaluate(condition(), draft, { failed: false }), { known: true, value: false })
  })

  test("a reviewer with write access re-runs the head's ci run", () => {
    permission('maintainer', 'write')
    fixture('runs.json', { workflow_runs: [{ id: 99, status: 'completed', html_url: 'https://x/99' }] })
    const out = runStep(rerun(), context('approved'))
    assert.equal(out.status, 0, out.output)
    assert.ok(out.calls.includes(`run rerun 99 --repo ${REPO}`), out.calls.join('\n'))
  })

  test('a reviewer without write access re-runs nothing', () => {
    permission('passer-by', 'read')
    fixture('runs.json', { workflow_runs: [{ id: 99, status: 'completed', html_url: 'https://x/99' }] })
    const out = runStep(rerun(), context('approved', 'passer-by'))
    assert.equal(out.status, 0, out.output)
    assert.ok(!out.calls.some((c) => c.startsWith('run ')), out.calls.join('\n'))
    assert.match(out.output, /passer-by/)
  })

  test('a pull request of no delivery.automated entry asks nothing', () => {
    const out = runStep(rerun(), context('approved', 'maintainer', pullRequest(rerun(), 'octocat', 'feat/1/x')))
    assert.equal(out.status, 0, out.output)
    assert.deepEqual(out.calls, [])
  })

  test('a permission the token cannot read fails the job, naming the reviewer', () => {
    const out = runStep(rerun(), context('approved'))
    assert.equal(out.status, 1)
    assert.match(out.output, /::error.*maintainer/)
  })
})
