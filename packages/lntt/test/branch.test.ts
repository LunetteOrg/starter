import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { branchName, branchRules, checkBranch, fromToolName, slugify, typeFor } from '../src/index.ts'

const rules = branchRules({})

describe('the rules', () => {
  test('default: the conventional types, no-issue, the base and candidates exempt', () => {
    assert.ok(rules.types.includes('feat') && rules.types.includes('fix') && rules.types.includes('docs'))
    assert.ok(rules.types.includes('hotfix'), 'the hotfix prefix is a type')
    assert.deepEqual(rules.exempt, ['main', 'candidate/', 'dependabot/'])
  })

  test('read from delivery: branches.types, the candidate base and prefix, the hotfix prefix', () => {
    const r = branchRules({
      delivery: {
        branches: { types: ['feat', 'fix'] },
        candidate: { base: 'trunk', prefix: 'rc-', hotfix: { prefix: 'urgent/' } },
      },
    })
    assert.deepEqual(r.types, ['feat', 'fix', 'urgent'])
    assert.deepEqual(r.exempt, ['trunk', 'rc-', 'dependabot/'])
  })
})

describe('slugify', () => {
  test('the first four meaningful words of a title, in kebab case', () => {
    assert.equal(slugify('Turn Ryuk back on, so a killed run cleans up'), 'turn-ryuk-back-killed')
    assert.equal(slugify('Add an orca.yaml to the starter'), 'add-orca-yaml-starter')
  })

  test('drops accents, code marks and symbols', () => {
    assert.equal(slugify('`lntt sync` installs the shared skills — già'), 'lntt-sync-installs-shared')
  })

  test('apostrophes join their word instead of splitting it', () => {
    assert.equal(slugify("Fix the user's login"), 'fix-users-login')
    assert.equal(slugify('Don’t drop the effort'), 'dont-drop-effort')
  })

  test('a title with nothing to keep gives an empty slug', () => {
    assert.equal(slugify('🚀'), '')
    assert.equal(slugify('It is the'), '')
  })

  test('the same title always gives the same slug', () => {
    const title = 'Board status for work merged into the release candidate'
    assert.equal(slugify(title), slugify(title))
  })
})

describe('typeFor', () => {
  test('the native issue type wins', () => {
    assert.equal(typeFor({ type: 'Bug', labels: ['enhancement'] }), 'fix')
    assert.equal(typeFor({ type: 'Feature', labels: [] }), 'feat')
    assert.equal(typeFor({ type: 'Task', labels: [] }), 'chore')
  })

  test('then labels, then feat', () => {
    assert.equal(typeFor({ labels: ['bug'] }), 'fix')
    assert.equal(typeFor({ labels: ['documentation'] }), 'docs')
    assert.equal(typeFor({ labels: ['enhancement'] }), 'feat')
    assert.equal(typeFor({ labels: [] }), 'feat')
  })
})

describe('branchName', () => {
  test('type/issue/slug, or type/no-issue/slug', () => {
    assert.equal(branchName('feat', 77, 'worktree-branch-names'), 'feat/77/worktree-branch-names')
    assert.equal(branchName('docs', null, 'version-numbering'), 'docs/no-issue/version-numbering')
  })
})

describe('checkBranch', () => {
  test('accepts the convention', () => {
    for (const name of ['feat/77/worktree-branch-names', 'refactor/102/lntt', 'docs/no-issue/a-b-c-d', 'hotfix/9/x']) {
      assert.deepEqual(checkBranch(name, rules), { ok: true }, name)
    }
  })

  test('lets the base, candidates and dependabot through', () => {
    for (const name of ['main', 'candidate/3', 'dependabot/npm_and_yarn/yaml-2.9.2']) {
      assert.deepEqual(checkBranch(name, rules), { ok: true }, name)
    }
  })

  test('refuses anything else, saying why', () => {
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
      assert.equal(r.ok, false, name)
      assert.match(r.ok ? '' : r.reason, reason, name)
    }
  })

  test('names the branch it should be when a tool flattened it', () => {
    const r = checkBranch('ilmeskio/feat-77-worktree-branch-names', rules)
    assert.equal(r.ok, false)
    assert.equal(r.ok ? undefined : r.expected, 'feat/77/worktree-branch-names')
  })
})

describe('fromToolName', () => {
  test('Orca: a user prefix, then type-issue-slug with the slashes flattened', () => {
    assert.equal(fromToolName('ilmeskio/chore-98-orca-yaml', rules), 'chore/98/orca-yaml')
    assert.equal(fromToolName('ilmeskio/docs-no-issue-version-numbering', rules), 'docs/no-issue/version-numbering')
  })

  test('the agent harness: worktree-type+issue+slug', () => {
    assert.equal(fromToolName('worktree-feat+77+branch-names', rules), 'feat/77/branch-names')
  })

  test('a name already right is returned as it is; one with nothing to read gives null', () => {
    assert.equal(fromToolName('feat/77/branch-names', rules), 'feat/77/branch-names')
    assert.equal(fromToolName('ilmeskio/probe-a', rules), null)
    assert.equal(fromToolName('ilmeskio/wip-77-thing', rules), null)
  })
})
