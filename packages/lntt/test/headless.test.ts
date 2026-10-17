import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { askAll, headlessInvocation, parseReply, providerOf, type Spawn } from '../src/index.ts'

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

  test('opencode: run on a standalone server, an inline agent allowed only to read, the prompt on stdin', () => {
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
    ])
    assert.equal(inv.stdin, 'PROMPT')
    const config = JSON.parse(inv.env.OPENCODE_CONFIG_CONTENT as string)
    // Everything denied, then the read tools allowed: a tool opencode adds is denied too.
    assert.deepEqual(config.agent['lntt-readonly'].permission, {
      '*': 'deny',
      read: 'allow',
      grep: 'allow',
      glob: 'allow',
      list: 'allow',
    })
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

  test('output that is not what the agent prints says which agent and what it printed', () => {
    assert.throws(() => parseReply('claude', 'Error: not logged in'), /claude printed no JSON: Error: not logged in/)
    assert.throws(() => parseReply('claude', ''), /claude printed no JSON/)
    assert.throws(
      () => parseReply('opencode', '{"type":"text"}\nboom'),
      /opencode printed a line that is not JSON: boom/,
    )
  })

  test('claude: a reply with no result is an error, not an empty review', () => {
    assert.throws(() => parseReply('claude', JSON.stringify({ is_error: false, session_id: 's' })), /no result/)
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

  test('every agent is running before the first answers: the answers are held until all have started', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    let started = 0
    const spawn: Spawn = async () => {
      started++
      if (started === 3) release()
      await gate
      return JSON.stringify({ result: 'r', session_id: 's', is_error: false })
    }
    const questions = ['A', 'B', 'C'].map((prompt) => ({ agent: { kind: 'claude' }, prompt }))
    const results = await askAll(questions, spawn)
    assert.equal(results.filter((r) => r.ok).length, 3)
  })

  test('an agent that cannot be started is a failure in its place, not a crash of the batch', async () => {
    const spawn: Spawn = async () => JSON.stringify({ result: 'r', session_id: 's', is_error: false })
    const results = await askAll(
      [
        { agent: { kind: 'codex' }, prompt: 'A' },
        { agent: { kind: 'claude' }, prompt: 'B' },
      ],
      spawn,
    )
    assert.equal(results[0]?.ok, false)
    assert.equal(results[1]?.ok, true)
  })

  test('at most `perProvider` agents of one provider at once; another provider is not held', async () => {
    const running: Record<string, number> = {}
    const peak: Record<string, number> = {}
    const spawn: Spawn = async (inv) => {
      const key = inv.command === 'claude' ? 'claude' : 'opencode'
      running[key] = (running[key] ?? 0) + 1
      peak[key] = Math.max(peak[key] ?? 0, running[key] as number)
      await new Promise((r) => setTimeout(r, 5))
      running[key] = (running[key] as number) - 1
      return key === 'claude'
        ? JSON.stringify({ result: 'r', session_id: 's', is_error: false })
        : JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { messageID: 'm', text: 'r' } })
    }
    const questions = [
      ...Array.from({ length: 5 }, () => ({ agent: { kind: 'claude' }, prompt: 'P' })),
      ...Array.from({ length: 3 }, () => ({ agent: { kind: 'opencode', model: 'x/y' }, prompt: 'P' })),
    ]
    const results = await askAll(questions, spawn, () => {}, { perProvider: 2 })
    assert.equal(results.filter((a) => a.ok).length, 8)
    assert.deepEqual(peak, { claude: 2, opencode: 2 })
  })

  test('the provider is the part of the model before the slash; claude is one provider', () => {
    assert.equal(providerOf({ kind: 'claude', model: 'sonnet' }), 'anthropic')
    assert.equal(providerOf({ kind: 'opencode', model: 'opencode/glm-5.3-flash-free' }), 'opencode')
    assert.equal(providerOf({ kind: 'opencode', model: 'mistral/devstral' }), 'mistral')
    assert.equal(providerOf({ kind: 'opencode' }), 'opencode')
  })

  test('a start is reported when the agent starts, not while it waits for its turn', async () => {
    const events: string[] = []
    const spawn: Spawn = async () => {
      events.push('spawn')
      return JSON.stringify({ result: 'r', session_id: 's', is_error: false })
    }
    await askAll(
      [
        { agent: { kind: 'claude' }, prompt: 'A', label: 'a' },
        { agent: { kind: 'claude' }, prompt: 'B', label: 'b' },
      ],
      spawn,
      (e) => events.push(`${e.type} ${e.label}`),
      { perProvider: 1 },
    )
    assert.deepEqual(events, ['start a', 'spawn', 'end a', 'start b', 'spawn', 'end b'])
  })

  test('optional agents still running a grace after the others answered are stopped, as failures', {
    timeout: 5000,
  }, async () => {
    const stopped: string[] = []
    const spawn: Spawn = (inv, signal) =>
      inv.stdin === 'fast'
        ? Promise.resolve(JSON.stringify({ result: 'r', session_id: 's', is_error: false }))
        : new Promise((_, reject) => {
            signal?.addEventListener('abort', () => {
              stopped.push(inv.stdin)
              reject(new Error(String(signal.reason)))
            })
          })
    const results = await askAll(
      [
        { agent: { kind: 'claude' }, prompt: 'fast' },
        { agent: { kind: 'claude', optional: true }, prompt: 'slow' },
        { agent: { kind: 'claude', optional: true }, prompt: 'queued' },
      ],
      spawn,
      () => {},
      { perProvider: 1, optionalGraceMs: 10 },
    )
    assert.equal(results[0]?.ok, true)
    assert.deepEqual(
      results.slice(1).map((a) => (a.ok ? 'ok' : a.error)),
      ['stopped: the other agents answered 0s before', 'stopped: the other agents answered 0s before'],
    )
    assert.deepEqual(stopped, ['slow'], 'the queued one never started')
  })

  test('when every agent is optional, none is stopped early', { timeout: 5000 }, async () => {
    const spawn: Spawn = () =>
      new Promise((resolve) =>
        setTimeout(() => resolve(JSON.stringify({ result: 'r', session_id: 's', is_error: false })), 20),
      )
    const results = await askAll([{ agent: { kind: 'claude', optional: true }, prompt: 'P' }], spawn, () => {}, {
      optionalGraceMs: 1,
    })
    assert.equal(results[0]?.ok, true)
  })
})
