import { assert, describe, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { type ChildProcess, ChildProcessSpawner } from 'effect/process'
import * as Sink from 'effect/Sink'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import { memoryFileSystem } from '../testing/file-system.ts'
import { HostEnv, hookScriptPath, orcaSubagents, subagentEvent } from './orca.ts'

const ORCA = {
  HOME: '/home/me',
  ORCA_AGENT_HOOK_PORT: '49711',
  ORCA_AGENT_HOOK_TOKEN: 't',
  ORCA_PANE_KEY: 'tab:pane',
  CLAUDE_CODE_SESSION_ID: 'sess',
}
const SCRIPT = '/home/me/.orca/agent-hooks/claude-hook.sh'

// Orca's hook script, as a spawner in memory: each run's command, environment and the event it
// read on stdin. `hang`: the script never ends, as one that cannot reach Orca.
function hook(options: { script?: boolean; hang?: boolean } = {}) {
  const fs = memoryFileSystem()
  const runs: { command: string; args: string[]; env: unknown; extendEnv: unknown; event: Record<string, unknown> }[] =
    []
  const spawn = (command: ChildProcess.Command) =>
    Effect.gen(function* () {
      if (command._tag !== 'StandardCommand') return yield* Effect.die('a piped command')
      const { options: given } = command
      const input = given.stdin
      const text = Stream.isStream(input)
        ? yield* Stream.mkString(Stream.decodeText(input as Stream.Stream<Uint8Array>))
        : ''
      runs.push({
        command: command.command,
        args: command.args.map(String),
        env: given.env,
        extendEnv: given.extendEnv,
        event: JSON.parse(text),
      })
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: options.hang ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    })
  const layer = Layer.mergeAll(
    fs.layer,
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(ChildProcessSpawner.make(spawn)),
  )
  const setup = options.script === false ? Effect.void : fs.put(SCRIPT, '#!/bin/sh\n')
  // What Orca heard so far, then forgotten.
  const heard = () =>
    runs
      .splice(0)
      .map(
        (run) =>
          `${run.event.hook_event_name} ${run.event.agent_id}${run.event.last_assistant_message ? ` ${run.event.last_assistant_message}` : ''}`,
      )
  return { layer, setup, runs, heard }
}

describe('Orca subagents', () => {
  it('only under a Claude Code session in Orca: its variables and a home', () => {
    assert.strictEqual(hookScriptPath(ORCA), SCRIPT)
    for (const name of [
      'ORCA_AGENT_HOOK_PORT',
      'ORCA_AGENT_HOOK_TOKEN',
      'ORCA_PANE_KEY',
      'CLAUDE_CODE_SESSION_ID',
      'HOME',
    ]) {
      assert.strictEqual(hookScriptPath({ ...ORCA, [name]: undefined }), null, name)
    }
  })

  it.effect("none when Orca's hook script is not there, or the session is not in Orca", () => {
    const orca = hook({ script: false })
    return Effect.gen(function* () {
      assert.strictEqual(yield* Effect.scoped(orcaSubagents('/w')).pipe(Effect.provideService(HostEnv, ORCA)), null)
      yield* orca.setup
      assert.strictEqual(yield* Effect.scoped(orcaSubagents('/w')).pipe(Effect.provideService(HostEnv, {})), null)
    }).pipe(Effect.provide(orca.layer))
  })

  it('the events Claude Code sends for a subagent, the label as its type', () => {
    assert.deepStrictEqual(subagentEvent('SubagentStart', 'sess', 'a1', 'code · claude sonnet', '/w'), {
      session_id: 'sess',
      transcript_path: '',
      cwd: '/w',
      hook_event_name: 'SubagentStart',
      agent_id: 'a1',
      agent_type: 'code · claude sonnet',
    })
    assert.strictEqual(
      subagentEvent('SubagentStop', 'sess', 'a1', 'x', '/w', 'no findings').last_assistant_message,
      'no findings',
    )
  })

  it.effect('each event is the hook script, with the session’s environment and nothing else', () => {
    const orca = hook()
    return Effect.gen(function* () {
      yield* orca.setup
      yield* Effect.scoped(
        Effect.gen(function* () {
          const subagents = yield* orcaSubagents('/w')
          subagents?.start('a1', 'one')
          yield* Effect.yieldNow
        }),
      )
      const [run] = orca.runs
      assert.deepStrictEqual([run?.command, run?.args, run?.env, run?.extendEnv], ['sh', [SCRIPT], ORCA, false])
      assert.deepStrictEqual(run?.event, subagentEvent('SubagentStart', 'sess', 'a1', 'one', '/w'))
    }).pipe(Effect.provideService(HostEnv, ORCA), Effect.provide(orca.layer))
  })

  // The clock is the test's: the reminder comes when the test moves time, however loaded the
  // machine is.
  it.effect('a running subagent is announced again until it stops; the scope’s end stops the rest', () => {
    const orca = hook()
    return Effect.gen(function* () {
      yield* orca.setup
      yield* Effect.scoped(
        Effect.gen(function* () {
          const s = yield* orcaSubagents('/w', '2 seconds')
          if (s === null) return assert.fail('no subagents')
          s.start('a1', 'one')
          s.start('a2', 'two')
          yield* Effect.yieldNow
          assert.deepStrictEqual(orca.heard(), ['SubagentStart a1', 'SubagentStart a2'])
          yield* TestClock.adjust('2 seconds')
          assert.deepStrictEqual(orca.heard(), ['SubagentStart a1', 'SubagentStart a2'], 'both announced again')
          s.stop('a1', 'one', 'done')
          yield* Effect.yieldNow
          assert.deepStrictEqual(orca.heard(), ['SubagentStop a1 done'], 'stop sends the message')
          yield* TestClock.adjust('2 seconds')
          assert.deepStrictEqual(orca.heard(), ['SubagentStart a2'], 'only a2 after a1 stopped')
        }),
      )
      assert.deepStrictEqual(orca.heard(), ['SubagentStop a2 stopped'], 'the end stops a2 and not a1 again')
      yield* TestClock.adjust('10 seconds')
      assert.deepStrictEqual(orca.heard(), [], 'nothing is announced after the end')
    }).pipe(Effect.provideService(HostEnv, ORCA), Effect.provide(orca.layer))
  })

  it.effect('a script that never ends does not hold the round: its end waits a moment, then goes', () => {
    const orca = hook({ hang: true })
    return Effect.gen(function* () {
      yield* orca.setup
      const ending = yield* Effect.forkChild(
        Effect.scoped(
          Effect.gen(function* () {
            ;(yield* orcaSubagents('/w'))?.start('a1', 'one')
          }),
        ),
      )
      yield* TestClock.adjust('2 seconds')
      yield* Effect.yieldNow
      assert.ok(ending.pollUnsafe() !== undefined, 'the scope closed')
      assert.deepStrictEqual(orca.heard(), ['SubagentStart a1', 'SubagentStop a1 stopped'])
    }).pipe(Effect.provideService(HostEnv, ORCA), Effect.provide(orca.layer))
  })
})
