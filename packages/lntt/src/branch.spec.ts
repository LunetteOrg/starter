import { assert, describe, it } from '@effect/vitest'
import {
  branchName,
  branchRules,
  checkBranch,
  fromToolName,
  nameFromIssue,
  pushedBranches,
  slugify,
  typeFor,
} from './branch.ts'

const rules = branchRules({})

describe('the rules', () => {
  it('default: the conventional types, no-issue, the base and candidates exempt', () => {
    assert.ok(rules.types.includes('feat') && rules.types.includes('fix') && rules.types.includes('docs'))
    assert.ok(rules.types.includes('hotfix'), 'the hotfix prefix is a type')
    assert.deepStrictEqual(rules.exempt, ['main', 'candidate/'])
  })

  it('read from delivery: branches.types, the candidate base and prefix, the hotfix prefix', () => {
    const r = branchRules({
      delivery: {
        branches: { types: ['feat', 'fix'] },
        candidate: { base: 'trunk', prefix: 'rc-', hotfix: { prefix: 'urgent/' } },
        automated: [{ branch: 'dependabot/' }, { branch: 'renovate/' }],
      },
    })
    assert.deepStrictEqual(r.types, ['feat', 'fix', 'urgent'])
    assert.deepStrictEqual(r.exempt, ['trunk', 'rc-', 'dependabot/', 'renovate/'])
  })
})

describe('slugify', () => {
  it('the first four meaningful words of a title, in kebab case', () => {
    assert.strictEqual(slugify('Turn Ryuk back on, so a killed run cleans up'), 'turn-ryuk-back-killed')
    assert.strictEqual(slugify('Add an orca.yaml to the starter'), 'add-orca-yaml-starter')
  })

  it('drops accents, code marks and symbols', () => {
    assert.strictEqual(slugify('`lntt sync` installs the shared skills — già'), 'lntt-sync-installs-shared')
  })

  it('apostrophes join their word instead of splitting it', () => {
    assert.strictEqual(slugify("Fix the user's login"), 'fix-users-login')
    assert.strictEqual(slugify('Don’t drop the effort'), 'dont-drop-effort')
  })

  it('a title with nothing to keep gives an empty slug', () => {
    assert.strictEqual(slugify('🚀'), '')
    assert.strictEqual(slugify('It is the'), '')
  })

  it('the same title always gives the same slug', () => {
    const title = 'Board status for work merged into the release candidate'
    assert.strictEqual(slugify(title), slugify(title))
  })
})

describe('typeFor', () => {
  it('the native issue type wins', () => {
    assert.strictEqual(typeFor({ type: 'Bug', labels: ['enhancement'] }), 'fix')
    assert.strictEqual(typeFor({ type: 'Feature', labels: [] }), 'feat')
    assert.strictEqual(typeFor({ type: 'Task', labels: [] }), 'chore')
  })

  it('then labels, then feat', () => {
    assert.strictEqual(typeFor({ labels: ['bug'] }), 'fix')
    assert.strictEqual(typeFor({ labels: ['documentation'] }), 'docs')
    assert.strictEqual(typeFor({ labels: ['enhancement'] }), 'feat')
    assert.strictEqual(typeFor({ labels: [] }), 'feat')
  })
})

describe('branchName', () => {
  it('type/issue/slug, or type/no-issue/slug', () => {
    assert.strictEqual(branchName('feat', 77, 'worktree-branch-names'), 'feat/77/worktree-branch-names')
    assert.strictEqual(branchName('docs', null, 'version-numbering'), 'docs/no-issue/version-numbering')
  })
})

describe('checkBranch', () => {
  it('accepts the convention', () => {
    for (const name of ['feat/77/worktree-branch-names', 'refactor/102/lntt', 'docs/no-issue/a-b-c-d', 'hotfix/9/x']) {
      assert.deepStrictEqual(checkBranch(name, rules), { ok: true }, name)
    }
  })

  it('lets the base, candidates and the branches of delivery.automated through', () => {
    const bots = branchRules({ delivery: { automated: [{ branch: 'dependabot/' }] } })
    for (const name of ['main', 'candidate/3', 'dependabot/npm_and_yarn/yaml-2.9.2']) {
      assert.deepStrictEqual(checkBranch(name, bots), { ok: true }, name)
    }
    assert.strictEqual(checkBranch('dependabot/npm_and_yarn/yaml-2.9.2', rules).ok, false)
  })

  it('refuses anything else, saying why', () => {
    const cases: [string, RegExp][] = [
      ['ilmeskio/orca-yaml-check', /type/],
      ['wip/77/thing', /type wip/],
      ['feat/abc/thing', /issue/],
      ['feat/77/Thing_Here', /slug/],
      ['feat/77/one-two-three-four-five', /slug/],
      ['feat/77', /type\/issue\/slug/],
    ]
    for (const [name, reason] of cases) {
      const r = checkBranch(name, rules)
      assert.strictEqual(r.ok, false, name)
      assert.match(r.ok ? '' : r.reason, reason, name)
    }
  })

  it('names the branch it should be when a tool flattened it', () => {
    const r = checkBranch('ilmeskio/feat-77-worktree-branch-names', rules)
    assert.strictEqual(r.ok, false)
    assert.strictEqual(r.ok ? undefined : r.expected, 'feat/77/worktree-branch-names')
  })
})

describe('fromToolName', () => {
  it('Orca: a user prefix, then type-issue-slug with the slashes flattened', () => {
    assert.strictEqual(fromToolName('ilmeskio/chore-98-orca-yaml', rules), 'chore/98/orca-yaml')
    assert.strictEqual(
      fromToolName('ilmeskio/docs-no-issue-version-numbering', rules),
      'docs/no-issue/version-numbering',
    )
  })

  it('the agent harness: worktree-type+issue+slug', () => {
    assert.strictEqual(fromToolName('worktree-feat+77+branch-names', rules), 'feat/77/branch-names')
  })

  it('a name already right is returned as it is; one with nothing to read gives null', () => {
    assert.strictEqual(fromToolName('feat/77/branch-names', rules), 'feat/77/branch-names')
    assert.strictEqual(fromToolName('ilmeskio/probe-a', rules), null)
    assert.strictEqual(fromToolName('ilmeskio/wip-77-thing', rules), null)
  })
})

describe('nameFromIssue', () => {
  const issue = {
    title: 'Branch names follow type/issue/slug whatever tool creates the worktree',
    labels: [{ name: 'enhancement' }],
    type: null,
  }

  it("the issue's type, its number, a slug of its title; --type and --slug override them", () => {
    assert.strictEqual(nameFromIssue(77, {}, issue), 'feat/77/branch-names-follow-type')
    assert.strictEqual(nameFromIssue(77, { type: 'chore', slug: 'orca-names' }, issue), 'chore/77/orca-names')
    assert.strictEqual(nameFromIssue(5, {}, { ...issue, type: { name: 'Bug' } }), 'fix/5/branch-names-follow-type')
  })
})

describe('pushedBranches', () => {
  const ZERO = '0000000000000000000000000000000000000000'
  const SHA = '1111111111111111111111111111111111111111'

  it('the branches a push creates or updates; tags and branch deletions are none', () => {
    assert.deepStrictEqual(pushedBranches(`refs/heads/main ${SHA} refs/heads/wip ${ZERO}\n`), ['wip'])
    assert.deepStrictEqual(pushedBranches(`refs/tags/v1 ${SHA} refs/tags/v1 ${ZERO}\n`), [])
    assert.deepStrictEqual(pushedBranches(`(delete) ${ZERO} refs/heads/old-thing ${SHA}\n`), [])
    assert.deepStrictEqual(pushedBranches(''), [])
  })
})
