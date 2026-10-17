import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { orcaHookScript, subagentEvent, subagents } from '../src/orca-subagents.ts'

const ORCA = {
  HOME: '/home/me',
  ORCA_AGENT_HOOK_PORT: '49711',
  ORCA_AGENT_HOOK_TOKEN: 't',
  ORCA_PANE_KEY: 'tab:pane',
  CLAUDE_CODE_SESSION_ID: 'sess',
}

describe('Orca subagents', () => {
  test("only under a Claude Code session in Orca, with Orca's hook script present", () => {
    assert.equal(
      orcaHookScript(ORCA, () => true),
      '/home/me/.orca/agent-hooks/claude-hook.sh',
    )
    assert.equal(
      orcaHookScript(ORCA, () => false),
      null,
    )
    for (const name of ['ORCA_AGENT_HOOK_PORT', 'ORCA_PANE_KEY', 'CLAUDE_CODE_SESSION_ID']) {
      assert.equal(
        orcaHookScript({ ...ORCA, [name]: undefined }, () => true),
        null,
        name,
      )
    }
  })

  test('the events Claude Code sends for a subagent, the label as its type', () => {
    assert.deepEqual(subagentEvent('SubagentStart', 'sess', 'a1', 'code · claude sonnet', '/w'), {
      session_id: 'sess',
      transcript_path: '',
      cwd: '/w',
      hook_event_name: 'SubagentStart',
      agent_id: 'a1',
      agent_type: 'code · claude sonnet',
    })
    assert.equal(
      subagentEvent('SubagentStop', 'sess', 'a1', 'x', '/w', 'no findings').last_assistant_message,
      'no findings',
    )
  })

  // The clock is the test's: the interval fires when the test says so, however loaded the
  // machine is.
  test('a running subagent is announced again until it stops; close stops the rest', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const sent: string[] = []
    const s = subagents((e) => sent.push(`${e.hook_event_name} ${e.agent_id}`), 'sess', '/w', 2000)
    s.start('a1', 'one')
    s.start('a2', 'two')
    t.mock.timers.tick(2000)
    t.mock.timers.tick(2000)
    assert.equal(sent.filter((x) => x === 'SubagentStart a1').length, 3, 'a1 announced, then twice more')
    s.stop('a1', 'one', 'done')
    const afterStop = sent.length
    t.mock.timers.tick(2000)
    assert.deepEqual(sent.slice(afterStop), ['SubagentStart a2'], 'only a2 after a1 stopped')
    s.close()
    assert.equal(sent.at(-1), 'SubagentStop a2')
  })
})
