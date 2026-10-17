import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { agentEnv } from '../src/review-cli.ts'

describe("the environment of a round's agent", () => {
  // Every variable the host's hook protocol sets: an agent that inherited one would report
  // to Orca (or Herdr) as the session that started the round.
  for (const name of [
    'ORCA_AGENT_HOOK_PORT',
    'ORCA_AGENT_HOOK_TOKEN',
    'ORCA_PANE_KEY',
    'ORCA_TAB_ID',
    'ORCA_AGENT_LAUNCH_TOKEN',
    'HERDR_ENV',
    'HERDR_PANE_ID',
  ]) {
    test(`${name} stays with the session that owns it`, () => {
      assert.deepEqual(agentEnv({ PATH: '/bin', [name]: 'x' }, {}), { PATH: '/bin' })
    })
  }

  test('every other variable is kept, those that only resemble a hook variable too', () => {
    const base = { PATH: '/bin', ORCA_PANE_KEY_OLD: 'a', ORCA_TAB_ID_OLD: 'b', MY_HERDR_HOME: 'c', ORCA_WORKTREE: 'd' }
    assert.deepEqual(agentEnv(base, {}), base)
  })

  test("a variable the base does not have is not invented, and the invocation's own override the base", () => {
    assert.deepEqual(agentEnv({ PATH: '/bin', GONE: undefined, CONFIG: 'old' }, { CONFIG: 'new', EXTRA: '1' }), {
      PATH: '/bin',
      CONFIG: 'new',
      EXTRA: '1',
    })
  })
})
