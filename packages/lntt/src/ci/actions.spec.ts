import { assert, describe, it } from '@effect/vitest'
import { drive } from '../testing/asks.ts'
import { actionName, localAction, versionMatches } from './actions.ts'
import { emptyConfig } from './config.ts'
import type { Local } from './plan.ts'

const check = (local: Local) => (local.kind === 'check' ? [local.note, local.check()] : local)

describe('localAction', () => {
  it('setup-node checks the host Node against node-version, or the file it names, read when the plan is made', async () => {
    const files = { '/repo/.nvmrc': '24\n' }
    const fromFile = await drive(
      localAction('actions/setup-node@v6', { 'node-version-file': '.nvmrc' }, '/repo', emptyConfig()),
      {
        files,
        node: 'v22.1.0',
      },
    )
    assert.deepStrictEqual(check(fromFile), [
      'the host Node matches .nvmrc (24)',
      'host Node is v22.1.0, .nvmrc asks for 24',
    ])
    const given = await drive(
      localAction('actions/setup-node@v6', { 'node-version': '24.15' }, '/repo', emptyConfig()),
      {
        node: 'v24.15.2',
      },
    )
    assert.deepStrictEqual(check(given), ['the host Node matches node-version (24.15)', null])
    // A spec that is no plain version cannot be compared: it passes.
    const lts = await drive(localAction('actions/setup-node@v6', { 'node-version': 'lts/*' }, '/repo', emptyConfig()))
    assert.deepStrictEqual(check(lts), ['the host Node matches node-version (lts/*)', null])
  })

  it('setup-node with a missing version file fails; with no version at all it uses the host Node', async () => {
    assert.deepStrictEqual(
      await drive(localAction('actions/setup-node@v6', { 'node-version-file': '.nvmrc' }, '/repo', emptyConfig())),
      { kind: 'fail', reason: 'node-version-file .nvmrc does not exist' },
    )
    assert.deepStrictEqual(await drive(localAction('actions/setup-node@v6', {}, '/repo', emptyConfig())), {
      kind: 'noop',
      note: 'no Node version asked for: the host Node is used',
    })
  })

  it('pnpm/action-setup checks that pnpm is on the PATH', async () => {
    const there = await drive(localAction('pnpm/action-setup@v6', {}, '/repo', emptyConfig()))
    assert.deepStrictEqual(check(there), ['pnpm is on the PATH', null])
    const missing = await drive(localAction('pnpm/action-setup@v6', {}, '/repo', emptyConfig()), {
      onPath: () => false,
    })
    assert.deepStrictEqual(check(missing), ['pnpm is on the PATH', 'pnpm is not on the PATH'])
  })

  it('ci.local.actions maps an action to a command or a skip, ahead of the known ones; any other fails', async () => {
    const config = {
      ...emptyConfig(),
      actions: { 'acme/lint': { run: 'pnpm lint' }, 'actions/checkout': { skip: 'no' } },
    }
    assert.deepStrictEqual(await drive(localAction('acme/lint@v1', {}, '/repo', config)), {
      kind: 'run',
      command: 'pnpm lint',
      shell: ['bash', '-e', '-c'],
      cwd: '/repo',
      env: {},
    })
    assert.deepStrictEqual(await drive(localAction('actions/checkout@v7', {}, '/repo', config)), {
      kind: 'noop',
      note: 'no',
    })
    const unknown = await drive(localAction('acme/deploy@v1', {}, '/repo', config))
    assert.strictEqual(unknown.kind, 'fail')
  })

  it('names an action without its ref, and compares plain version prefixes only', () => {
    assert.strictEqual(actionName('actions/cache/restore@v4'), 'actions/cache/restore')
    assert.strictEqual(versionMatches('v24', 'v24.15.0'), true)
    assert.strictEqual(versionMatches('24.14', 'v24.15.0'), false)
    assert.strictEqual(versionMatches('>=24', 'v24.15.0'), null)
  })
})
