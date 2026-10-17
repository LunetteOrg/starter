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
    const sent: Record<string, unknown>[] = []
    const s = subagents((e) => sent.push(e), 'sess', '/w', 2000)
    const seen = () => sent.splice(0).map((e) => `${e.hook_event_name} ${e.agent_id}`)
    s.start('a1', 'one')
    s.start('a2', 'two')
    assert.deepEqual(seen(), ['SubagentStart a1', 'SubagentStart a2'])
    t.mock.timers.tick(2000)
    assert.deepEqual(seen(), ['SubagentStart a1', 'SubagentStart a2'], 'both announced again')
    t.mock.timers.tick(2000)
    assert.deepEqual(seen(), ['SubagentStart a1', 'SubagentStart a2'])
    s.stop('a1', 'one', 'done')
    assert.deepEqual(
      sent.map((e) => [e.hook_event_name, e.agent_id, e.last_assistant_message]),
      [['SubagentStop', 'a1', 'done']],
      'stop sends the message',
    )
    seen()
    t.mock.timers.tick(2000)
    assert.deepEqual(seen(), ['SubagentStart a2'], 'only a2 after a1 stopped')
    s.close()
    assert.deepEqual(
      sent.map((e) => [e.hook_event_name, e.agent_id, e.last_assistant_message]),
      [['SubagentStop', 'a2', 'stopped']],
      'close stops a2 and does not stop a1 again',
    )
    seen()
    t.mock.timers.tick(2000)
    assert.deepEqual(seen(), [], 'nothing is announced after close')
  })
})
