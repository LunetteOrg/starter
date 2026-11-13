// `lntt check` on Effect (docs/adr/effect-in-lntt.md): every configured area, one area, one of its
// checks, a mutation, or what is on lines (`cite`). src/check-cli.ts parses the arguments, exit 2
// before Effect loads, and loads this module when the command runs.
//
// The logic reaches the machine only through services: git (Git), GitHub (Gh), the working tree
// (FileSystem, Path), the tests a mutation runs (TestRunner), the worktree's lock (lockWorktree),
// the terminal (Console), and the sync code of `lntt sync`'s areas (SyncAreas, src/check/areas.ts).
// A mutation holds the worktree's lock and its scratch worktree as resources of the command's
// scope: an interrupt releases them, then the command exits 130. src/check/command.spec.ts runs it
// on in-memory layers.
//
// lntt review reads the areas a lens is named after through Checks, the service this module gives.

import * as Console from 'effect/Console'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import type * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import type { PlatformError } from 'effect/PlatformError'
import { candidateConfigOf } from '../ci/config.ts'
import { loadConfig } from '../config/load.ts'
import { exit, printed } from '../exit.ts'
import { Gh, GhLive } from '../gh/gh.ts'
import { Git, GitLive } from '../git/git.ts'
import { retroComment } from '../pull-request.ts'
import { type Query, runQuery } from '../query.ts'
import { isCandidate } from '../retro.ts'
import { runCommand } from '../run-command.ts'
import { SpawnerLive } from '../spawner.ts'
import { lockWorktree, WorktreeLockLive } from '../worktree/lock.ts'
import { agentsMdResults, bodyArea, CheckFailed, pluginResults, readText, skillsResults, synced } from './areas.ts'
import { checkDecisions, decisionBoardRefs, decisionFigures, givenPaths } from './decisions.ts'
import { projectTree } from './files.ts'
import { mutateAll, type TestRunner, TestRunnerLive } from './mutate.ts'
import {
  ANCHOR_LINE,
  AREAS,
  type Area,
  type CheckOptions,
  citeResult,
  citeTarget,
  citeText,
  failed,
  formatJson,
  formatText,
  type Result,
} from './results.ts'
import { runTests } from './tests.ts'
import type { Tree } from './tree.ts'

// A command as check-cli.ts parsed it, with the directory it runs in.
export type CheckCommand = {
  cwd: string
  base?: string
  json: boolean
  query?: string
} & (
  | { kind: 'cite'; anchors: string[] }
  | { kind: 'all' }
  // `files`: the files a check of the decisions takes. `body`: the body read from stdin (`-`),
  // or the pull request to read it from (`pr`, the current branch's when absent).
  | { kind: 'area'; area: Area; check?: string; files: string[]; body?: { stdin: string } | { pr?: number } }
  | { kind: 'mutate'; anchor: string; text: string; to: string; tests: string[] }
)

// One area, or one of its checks: `structure`, `board-refs` and `numbers` for the decisions,
// `levels`, `focus`, `rules` and `touched` for the tests. `tree` reads the project once, when an
// area needs it.
export const runArea = Effect.fnUntraced(function* (
  area: Area,
  check: string | undefined,
  files: string[],
  options: CheckOptions,
  tree: Effect.Effect<Tree, CheckFailed | PlatformError, FileSystem.FileSystem | Path.Path | Git>,
) {
  const { root } = options
  if (area === 'agents-md') return agentsMdResults(yield* synced((c) => c.agentsBlock(root)))
  if (area === 'skills') return skillsResults(yield* synced((c) => c.skills(root)))
  if (area === 'plugin') return pluginResults(yield* synced((c) => c.settings(root)))
  if (area === 'workflows') return yield* synced((c) => c.workflows(root, options.data))
  if (area === 'tests') return yield* runTests(check, options, yield* tree)
  if (area === 'body') return yield* bodyArea(check, options)
  if (check === 'numbers') return yield* decisionFigures(options, yield* tree, files)
  if (check === 'board-refs')
    return yield* decisionBoardRefs(options, yield* tree, yield* givenPaths(root, options.cwd ?? root, files))
  return yield* checkDecisions(options, yield* tree, { figures: check === undefined })
})

// The project read once, on first use, with `also` besides its files.
const lazyTree = (root: string, also: string[] = []) => Effect.cached(projectTree(root, also))

// The text the body area's retrospective check reads: stdin for `-`, else the pull request named,
// else the current branch's, read with gh. A candidate's block is not in its body, which the
// automation rebuilds at every squash, but in its retrospective comment.
const readBody = Effect.fnUntraced(function* (
  given: { stdin: string } | { pr?: number },
  data: Record<string, unknown>,
) {
  if ('stdin' in given) return { text: given.stdin, from: 'stdin' }
  const gh = yield* Gh
  const cannot = (error: { message: string }) => new CheckFailed({ message: error.message.split('\n')[0] as string })
  const found = yield* gh.pullRequest(given.pr).pipe(Effect.mapError(cannot))
  if (isCandidate(candidateConfigOf(data), found.headRefName)) {
    const comments = yield* gh
      .issueComments({ repo: '{owner}/{repo}', number: found.number })
      .pipe(Effect.mapError(cannot))
    const comment = retroComment(comments)
    return {
      text: comment?.body ?? '',
      from: `${comment === null ? 'the comments' : 'the retrospective comment'} of candidate #${found.number}`,
    }
  }
  return {
    text: found.body ?? '',
    from: given.pr === undefined ? "the current branch's pull request" : `pull request #${given.pr}`,
  }
})

// What is on each `path:line`, from the files of the project's root.
const cite = Effect.fnUntraced(function* (root: string, anchors: string[]) {
  const path = yield* Path.Path
  const results: Result[] = []
  for (const anchor of anchors) {
    const [, file, line] = ANCHOR_LINE.exec(anchor) as unknown as [string, string, string]
    const target = citeTarget(path, root, file, Number(line))
    const text = target.file === null ? null : yield* readText('/', target.file).pipe(Effect.orElseSucceed(() => null))
    results.push(citeResult(file, Number(line), citeText(text, target.at)))
  }
  return results
})

// The results of a command. Its configuration is the one found from the working directory; the
// root of the project is where that configuration is, as `lntt sync` writes it.
export const results = Effect.fnUntraced(function* (parsed: CheckCommand) {
  const path = yield* Path.Path
  const loaded = yield* loadConfig(parsed.cwd)
  const root = path.dirname(path.dirname(loaded.path))
  if (parsed.kind === 'cite') return yield* cite(root, parsed.anchors)
  const options: CheckOptions = {
    root,
    cwd: parsed.cwd,
    data: loaded.data,
    ...(parsed.base === undefined ? {} : { base: parsed.base }),
  }
  if (parsed.kind === 'mutate') {
    // A mutation rewrites files of the tree a round of lntt review reads, and its runs weigh on the
    // machine: it holds the worktree's lock, the one a round holds (src/worktree/lock.ts).
    const gitDir = yield* (yield* Git)
      .gitDirOf(root)
      .pipe(Effect.mapError(() => new CheckFailed({ message: `${root} has no git directory: a mutation needs one` })))
    yield* lockWorktree(gitDir, 'lntt check tests mutate')
    const [, file, line] = ANCHOR_LINE.exec(parsed.anchor) as unknown as [string, string, string]
    return yield* mutateAll(root, loaded.data, [
      { path: file, line: Number(line), text: parsed.text, to: parsed.to, tests: parsed.tests },
    ])
  }
  if (parsed.kind === 'all') {
    const tree = yield* lazyTree(root)
    const all: Result[] = []
    for (const area of AREAS) all.push(...(yield* runArea(area, undefined, [], options, tree)))
    return all
  }
  if (parsed.area === 'body' && parsed.body !== undefined) options.body = yield* readBody(parsed.body, loaded.data)
  const also = parsed.check === 'numbers' ? parsed.files : []
  return yield* runArea(parsed.area, parsed.check, parsed.files, options, yield* lazyTree(root, also))
}, Effect.scoped)

// What a command ends with: its results, and its exit code, null when a query is still to print.
interface Ending {
  found: Result[]
  code: number | null
}

const fail = (line: string) => Effect.as(Console.error(line), { found: [], code: 1 } as Ending)

// The query of a command, given its results, as `after` runs it: outside the runner (src/query.ts).
export const queryOf = (parsed: CheckCommand, found: Result[]): Query => ({
  input: formatJson(found),
  expression: parsed.query as string,
  json: parsed.json,
  code: failed(found) ? 1 : 0,
  command: 'lntt check',
})

// A command's results, printed, and its exit code: 1 when a check fails, 1 for an expected
// failure, said in one line. With a query, the results themselves: `after` prints the query.
export const command = (parsed: CheckCommand) =>
  results(parsed).pipe(
    Effect.flatMap((found): Effect.Effect<Ending> => {
      if (parsed.query !== undefined) return Effect.succeed({ found, code: null })
      const text = (parsed.json ? formatJson(found) : formatText(found)).replace(/\n$/, '')
      return Effect.as(text === '' ? Effect.void : Console.log(text), { found, code: failed(found) ? 1 : 0 })
    }),
    Effect.catchTags({
      CheckFailed: (error) => fail(`lntt: error: ${error.message}`),
      LockedError: (error) => fail(`lntt: error: ${error.message}`),
      ConfigInvalid: (error) => fail(`lntt: ${error.message}`),
      NoConfig: (error) => fail(`lntt: ${error.message}`),
      PlatformError: (error) => fail(`lntt: error: ${error.message}`),
    }),
  )

// The services on the machine.
const Live = Layer.mergeAll(GitLive, GhLive, TestRunnerLive).pipe(
  Layer.provideMerge(Layer.mergeAll(SpawnerLive, WorktreeLockLive, Path.layer)),
)

// Runs a command as the process's main program (src/run-command.ts): its exit code; with a query,
// the query runs once the runner has let go of the signals.
export function runCheck(parsed: CheckCommand): Promise<never> {
  const main: Effect.Effect<Ending> = command(parsed).pipe(Effect.provide(Live))
  if (parsed.query === undefined) return runCommand(main.pipe(Effect.map(({ code }) => exit(code ?? 0))))
  return runCommand(main, {
    after: async ({ found, code }: Ending) => (code !== null ? code : printed(await runQuery(queryOf(parsed, found)))),
  })
}

// ---- the areas lntt review reads -------------------------------------------------

export interface CheckedAreas {
  // The results of lntt check's areas a lens is named after, as their JSON. A review round runs no
  // test: touched places the lines from the imports, never by coverage.
  readonly lenses: (
    areas: Area[],
    options: { root: string; data: Record<string, unknown>; base: string },
  ) => Effect.Effect<Record<string, string>, CheckFailed>
}

export class Checks extends Context.Service<Checks, CheckedAreas>()('@lntt/lntt/check/command/Checks') {}

// The areas over the services of the layer that builds it: those of lntt review.
export const ChecksLive = Layer.effect(Checks)(
  Effect.gen(function* () {
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path | Git | TestRunner>()
    return Checks.of({
      lenses: (areas, { root, data, base }) =>
        Effect.gen(function* () {
          const tree = yield* lazyTree(root)
          const out: Record<string, string> = {}
          for (const area of areas) {
            out[area] = formatJson(yield* runArea(area, undefined, [], { root, data, base, coverage: false }, tree))
          }
          return out
        }).pipe(
          Effect.scoped,
          Effect.catchTag('PlatformError', (error) => Effect.fail(new CheckFailed({ message: error.message }))),
          Effect.provideContext(services),
        ),
    })
  }),
)
