// `lntt dump` on Effect (docs/adr/effect-in-lntt.md): what a report on Lunette needs, collected and
// redacted (src/dump/collect.ts), printed as Markdown or (--json) one JSON object. src/issue-cli.ts
// parses its arguments (a usage error exits 2 before Effect loads), reads the session at the edge
// and loads this module when the command runs.
//
// The logic reaches the machine only through services: the files (FileSystem, Path), the processes
// (the spawner) and the terminal (Console). src/dump/command.spec.ts runs it on in-memory layers.

import * as NodeFileSystem from '@effect/platform-node-shared/NodeFileSystem'
import * as NodePath from '@effect/platform-node-shared/NodePath'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import { findConfig } from '../config/load.ts'
import { type Dump, renderDump } from '../dump.ts'
import { exit, printed } from '../exit.ts'
import { type Query, runQuery } from '../query.ts'
import { runCommand } from '../run-command.ts'
import { SpawnerLive } from '../spawner.ts'
import { collectDump, type Machine, runFailing } from './collect.ts'

// A command as src/issue-cli.ts parsed it, with what it read from the session. `failing`: the
// command given after `--`.
export interface DumpCommand {
  cwd: string
  env: Record<string, string | undefined>
  machine: Machine
  json: boolean
  query?: string
  harness?: string
  model?: string
  failing?: string[]
}

// How a command ends: its exit code (null when a query is still to print) and its dump.
interface Ending {
  code: number | null
  dump?: Dump
}

const fail = (line: string) => Effect.as(Console.error(line), { code: 1 } as Ending)

// The project's root: the directory of .agents/, else the current one.
const rootOf = (cwd: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    return yield* findConfig(cwd).pipe(
      Effect.map((located) => path.dirname(path.dirname(located.path))),
      Effect.catchTag('NoConfig', () => Effect.succeed(cwd)),
    )
  })

// The dump printed whole, then red when the configuration does not validate: exit 1 with its error
// in one line. A refusal or a failure is one line, exit 1.
export const command = (parsed: DumpCommand) =>
  Effect.gen(function* () {
    const root = yield* rootOf(parsed.cwd)
    const dump = yield* collectDump({
      root,
      env: parsed.env,
      machine: parsed.machine,
      ...(parsed.harness === undefined ? {} : { harness: parsed.harness }),
      ...(parsed.model === undefined ? {} : { model: parsed.model }),
      ...(parsed.failing === undefined ? {} : { command: yield* runFailing(parsed.failing, parsed.cwd) }),
    })
    if (parsed.query !== undefined) return { code: null, dump } as Ending
    yield* parsed.json ? Console.log(JSON.stringify(dump)) : Console.log(renderDump(dump).replace(/\n$/, ''))
    if (dump.configError === undefined) return { code: 0, dump } as Ending
    yield* Console.error(`lntt dump: ${dump.configError}`)
    return { code: 1, dump } as Ending
  }).pipe(
    Effect.catchTags({
      DumpFailed: (error) => fail(`lntt dump: ${error.message}`),
      ConfigInvalid: (error) => fail(`lntt dump: ${error.message}`),
      PlatformError: (error) => fail(`lntt dump: ${error.message}`),
    }),
  )

// The query of `lntt dump --query`, on its dump: its code 1 when the configuration does not
// validate.
export const queryOf = (parsed: DumpCommand, dump: Dump): Query => ({
  input: JSON.stringify(dump),
  expression: parsed.query as string,
  json: parsed.json,
  code: dump.configError === undefined ? 0 : 1,
  command: 'lntt dump',
})

const Live = Layer.mergeAll(SpawnerLive, NodeFileSystem.layer, NodePath.layer)

// Runs a command as the process's main program (src/run-command.ts). With a query, the query runs
// once the runner has let go of the signals; a configuration that does not validate then says so
// after it, unless jq failed.
export function runDump(parsed: DumpCommand): Promise<never> {
  const main = command(parsed).pipe(Effect.provide(Live))
  if (parsed.query === undefined) return runCommand(main.pipe(Effect.map(({ code }) => exit(code ?? 0))))
  return runCommand(main, {
    after: async ({ code, dump }: Ending) => {
      if (code !== null || dump === undefined) return code ?? 1
      const query = queryOf(parsed, dump)
      const ran = printed(await runQuery(query))
      if (ran !== query.code || dump.configError === undefined) return ran
      return printed({ code: 1, out: '', err: `lntt dump: ${dump.configError}\n` })
    },
  })
}
