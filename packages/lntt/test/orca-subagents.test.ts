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

  test('a running subagent is announced again until it stops; close stops the rest', async () => {
    const sent: string[] = []
    const s = subagents((e) => sent.push(`${e.hook_event_name} ${e.agent_id}`), 'sess', '/w', 10)
    s.start('a1', 'one')
    s.start('a2', 'two')
    await new Promise((r) => setTimeout(r, 35))
    s.stop('a1', 'one', 'done')
    const afterStop = sent.length
    await new Promise((r) => setTimeout(r, 25))
    assert.ok(sent.filter((x) => x === 'SubagentStart a1').length >= 3, 'a1 re-announced while running')
    assert.ok(
      sent.slice(afterStop).every((x) => x !== 'SubagentStart a1'),
      'a1 not announced after its stop',
    )
    s.close()
    assert.equal(sent.at(-1), 'SubagentStop a2')
  })
})
