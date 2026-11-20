// `lntt local app`, `lntt viewer` and `lntt browser` on Effect (docs/adr/effect-in-lntt.md).
// src/cli.ts parses their arguments (a usage error exits 2 before Effect loads), reads what they
// take from the environment (the directory, the home, the variables, the platform, the temporary
// directory) and loads this module only for them.
//
// The logic reaches the machine only through services: the configuration and the operator profile
// (FileSystem, Path, Git), the PATH and the viewers (the spawner) and the terminal (Console).
// src/local/command.spec.ts runs it on their in-memory layers.

import * as NodeFileSystem from '@effect/platform-node-shared/NodeFileSystem'
import * as NodePath from '@effect/platform-node-shared/NodePath'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { browserApp, browserPlan, chooseDriver, type Driver, formatPlan } from '../browser.ts'
import { loadConfig, loadOperator } from '../config/load.ts'
import { exit, printed } from '../exit.ts'
import { Git, gitAt } from '../git/git.ts'
import { type Query, runQuery } from '../query.ts'
import { runCommand } from '../run-command.ts'
import { SpawnerLive } from '../spawner.ts'
import { agentAction, chooseViewer, openingOf, type Viewer, viewerCommands } from '../viewer.ts'
import { LocalFailed, localApp, onPathOf, open } from './machine.ts'

// What the session gives every command: where it runs and the operator's home, its variables and
// Node's platform.
export interface Session {
  cwd: string
  home: string
  env: Record<string, string | undefined>
  platform: string
}

// A command as src/cli.ts parsed it.
export type LocalCommand = Session &
  (
    | { kind: 'app'; name: string }
    | { kind: 'viewer'; open?: string }
    // `tmp`: where playwright's session writes its output.
    | { kind: 'browser'; app?: string; json: boolean; query?: string; tmp: string }
  )

const json = (value: unknown) => Console.log(JSON.stringify(value))

// The operator's preferred viewers or browsers (workspace.viewers, workspace.browsers).
const preferred = Effect.fnUntraced(function* (home: string, key: 'viewers' | 'browsers') {
  const { profile } = yield* loadOperator(home)
  return ((profile.workspace as Record<string, unknown> | undefined)?.[key] ?? []) as string[]
})

// `lntt viewer detect` prints the choice; `lntt viewer open <url>` opens the page there, or prints
// the agent's call and exits 3 when only the agent can open it.
const viewer = Effect.fnUntraced(function* (parsed: Extract<LocalCommand, { kind: 'viewer' }>) {
  const has = yield* onPathOf(viewerCommands(parsed.platform))
  const preferences = (yield* preferred(parsed.home, 'viewers')) as Viewer[]
  const choice = chooseViewer({ env: parsed.env, preferences, has, platform: parsed.platform })
  if (parsed.open === undefined) {
    yield* json(choice)
    return 0
  }
  const opening = openingOf(choice, parsed.open, yield* (yield* Git).root, parsed.platform)
  if (opening === null) {
    yield* json(agentAction(choice, parsed.open))
    return 3
  }
  yield* open(opening)
  return 0
})

// `lntt browser`: the plan, as a document or (--json) as JSON; with a query, the plan for `after`.
const browser = Effect.fnUntraced(function* (parsed: Extract<LocalCommand, { kind: 'browser' }>) {
  const { data } = yield* loadConfig(parsed.cwd)
  const name = yield* Effect.try({
    try: () => browserApp(data, parsed.app),
    catch: (error) => new LocalFailed({ message: error instanceof Error ? error.message : String(error) }),
  })
  const app = yield* localApp(data, name)
  const has = yield* onPathOf(['orca'])
  const preferences = (yield* preferred(parsed.home, 'browsers')) as Driver[]
  const plan = browserPlan({
    app,
    choice: chooseDriver({ env: parsed.env, preferences, has }),
    worktree: yield* (yield* Git).root,
    tmp: parsed.tmp,
  })
  if (parsed.query !== undefined) return { plan, code: null }
  yield* parsed.json ? json(plan) : Console.log(formatPlan(plan).replace(/\n$/, ''))
  return { plan, code: 0 }
})

// What a command ends with: its exit code, null when a query is still to print, and what the
// query reads.
interface Ending {
  code: number | null
  input?: string
}

const fail = (line: string) => Effect.as(Console.error(line), { code: 1 } as Ending)

// A command's exit code: 1 for an expected failure, said in one line.
export const command = (parsed: LocalCommand) =>
  Effect.gen(function* () {
    if (parsed.kind === 'app') {
      const { data } = yield* loadConfig(parsed.cwd)
      yield* json(yield* localApp(data, parsed.name))
      return { code: 0 } as Ending
    }
    if (parsed.kind === 'viewer') return { code: yield* viewer(parsed) } as Ending
    const { plan, code } = yield* browser(parsed)
    return { code, input: JSON.stringify(plan) } as Ending
  }).pipe(
    Effect.catchTags({
      LocalFailed: (error) => fail(`lntt: ${error.message}`),
      ConfigInvalid: (error) => fail(`lntt: ${error.message}`),
      NoConfig: (error) => fail(`lntt: ${error.message}`),
      GitError: (error) => fail(`lntt: error: ${error.message}`),
      PlatformError: (error) => fail(`lntt: error: ${error.message}`),
    }),
  )

// The query of `lntt browser --query`, on its plan.
export const queryOf = (parsed: Extract<LocalCommand, { kind: 'browser' }>, input: string): Query => ({
  input,
  expression: parsed.query as string,
  json: parsed.json,
  code: 0,
  command: 'lntt browser',
})

// The services on the machine, git in `cwd`.
const live = (cwd: string) =>
  gitAt(cwd).pipe(
    Layer.provideMerge(SpawnerLive),
    Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
  )

// Runs a command as the process's main program (src/run-command.ts); with a query, the query runs
// once the runner has let go of the signals.
export function runLocal(parsed: LocalCommand): Promise<never> {
  const main = command(parsed).pipe(Effect.provide(live(parsed.cwd)))
  if (parsed.kind !== 'browser' || parsed.query === undefined) {
    return runCommand(main.pipe(Effect.map(({ code }) => exit(code ?? 0))))
  }
  return runCommand(main, {
    after: async ({ code, input }: Ending) =>
      code !== null ? code : printed(await runQuery(queryOf(parsed, input as string))),
  })
}
