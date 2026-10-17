import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { askAll, headlessInvocation, parseReply, type Spawn } from '../src/index.ts'

describe('a headless agent, read-only', () => {
  test('claude: print mode, JSON, only the read tools and no MCP server, the prompt on stdin', () => {
    const inv = headlessInvocation({ kind: 'claude', model: 'sonnet', effort: 'medium' }, 'PROMPT')
    assert.equal(inv.command, 'claude')
    assert.deepEqual(inv.args, [
      '-p',
      '--output-format',
      'json',
      '--tools',
      'Read,Grep,Glob',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--model',
      'sonnet',
      '--effort',
      'medium',
    ])
    assert.equal(inv.stdin, 'PROMPT')
    assert.deepEqual(inv.env, {})
  })

  test('claude: a session to resume', () => {
    const inv = headlessInvocation({ kind: 'claude' }, 'P', 'abc')
    assert.deepEqual(inv.args.slice(-2), ['--resume', 'abc'])
  })

  test('opencode: run on a standalone server, an inline agent that can only read, the prompt as the message', () => {
    const inv = headlessInvocation({ kind: 'opencode', model: 'opencode/deepseek-v4.1-flash-free' }, 'PROMPT', 'ses_1')
    assert.equal(inv.command, 'opencode')
    assert.deepEqual(inv.args, [
      'run',
      '--standalone',
      '--agent',
      'lntt-readonly',
      '--format',
      'json',
      '-m',
      'opencode/deepseek-v4.1-flash-free',
      '-s',
      'ses_1',
      'PROMPT',
    ])
    assert.equal(inv.stdin, null)
    const config = JSON.parse(inv.env.OPENCODE_CONFIG_CONTENT as string)
    const permission = config.agent['lntt-readonly'].permission
    for (const tool of ['edit', 'bash', 'webfetch', 'websearch', 'task', 'execute', 'subagent', 'question']) {
      assert.equal(permission[tool], 'deny', tool)
    }
  })

  test('refused: an agent it has no read-only mode for, an effort opencode cannot take', () => {
    assert.throws(() => headlessInvocation({ kind: 'codex' }, 'P'), /claude, opencode/)
    assert.throws(() => headlessInvocation({ kind: 'opencode', effort: 'high' }, 'P'), /effort/)
    assert.throws(() => headlessInvocation({ kind: 'opencode', model: 'deepseek' }, 'P'), /provider\/model/)
  })
})

describe('the reply', () => {
  test('claude: the result, the session and the cost', () => {
    const out = JSON.stringify({
      type: 'result',
      is_error: false,
      result: 'TEXT',
      session_id: 's1',
      total_cost_usd: 0.02,
    })
    assert.deepEqual(parseReply('claude', out), { text: 'TEXT', session: 's1', cost: 0.02 })
  })

  test('claude: an error is an error', () => {
    const out = JSON.stringify({ type: 'result', is_error: true, result: 'Credit balance too low', session_id: 's1' })
    assert.throws(() => parseReply('claude', out), /Credit balance too low/)
  })

  test('opencode: the text of the last message, its session, no cost', () => {
    const line = (o: object) => JSON.stringify(o)
    const out = [
      line({ type: 'step_start', sessionID: 'ses_1', part: { messageID: 'm1' } }),
      line({ type: 'text', sessionID: 'ses_1', part: { messageID: 'm1', type: 'text', text: 'thinking aloud' } }),
      line({ type: 'text', sessionID: 'ses_1', part: { messageID: 'm2', type: 'text', text: 'first' } }),
      line({ type: 'text', sessionID: 'ses_1', part: { messageID: 'm2', type: 'text', text: 'second' } }),
    ].join('\n')
    assert.deepEqual(parseReply('opencode', out), { text: 'first\nsecond', session: 'ses_1', cost: null })
  })

  test('opencode: an error event, or no text at all, is an error', () => {
    const error = JSON.stringify({
      type: 'error',
      sessionID: '',
      error: { message: 'Expected a string starting with "ses"' },
    })
    assert.throws(() => parseReply('opencode', error), /starting with "ses"/)
    assert.throws(() => parseReply('opencode', ''), /no reply/)
  })
})

describe('several agents at once', () => {
  test('all start before any ends; each answer stays with its job, a failure with its reason', async () => {
    const started: string[] = []
    const spawn: Spawn = (inv) => {
      started.push(inv.stdin ?? '')
      return new Promise((resolve, reject) =>
        setTimeout(() => {
          if (inv.stdin === 'B') reject(new Error('timed out after 1 minutes'))
          else resolve(JSON.stringify({ result: `re ${inv.stdin}`, session_id: inv.stdin, is_error: false }))
        }, 5),
      )
    }
    const results = await askAll(
      [
        { agent: { kind: 'claude' }, prompt: 'A' },
        { agent: { kind: 'claude' }, prompt: 'B' },
        { agent: { kind: 'claude' }, prompt: 'C' },
      ],
      spawn,
    )
    assert.deepEqual(started, ['A', 'B', 'C'])
    assert.deepEqual(results, [
      { ok: true, reply: { text: 're A', session: 'A', cost: null } },
      { ok: false, error: 'timed out after 1 minutes' },
      { ok: true, reply: { text: 're C', session: 'C', cost: null } },
    ])
  })

  test('reports each start and end, with the label and the time it took', async () => {
    const events: string[] = []
    const spawn: Spawn = (inv) =>
      inv.stdin === 'B'
        ? Promise.reject(new Error('exited 1'))
        : Promise.resolve(JSON.stringify({ result: 'r', session_id: 's', is_error: false, total_cost_usd: 0.5 }))
    await askAll(
      [
        { agent: { kind: 'claude' }, prompt: 'A', label: 'code · claude' },
        { agent: { kind: 'claude' }, prompt: 'B', label: 'tests · claude' },
      ],
      spawn,
      (event) =>
        events.push(
          `${event.label} ${event.type}${event.type === 'end' ? ` ${event.answer.ok} ${typeof event.ms}` : ''}`,
        ),
    )
    assert.deepEqual(events.slice(0, 2), ['code · claude start', 'tests · claude start'])
    assert.deepEqual(events.slice(2).sort(), ['code · claude end true number', 'tests · claude end false number'])
  })
})
