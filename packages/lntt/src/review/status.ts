// `lntt review status` (with --clear and --prune) and `lntt review cost` on Effect
// (docs/adr/effect-in-lntt.md): what the review store keeps for the current branch, read and never
// written but by --clear and --prune, which never take the worktree's lock and never touch it.
// src/review-cli.ts parses the arguments (a usage error exits 2 before Effect loads) and loads this
// module when the command runs.
//
// The logic reaches the machine only through services: git (Git), GitHub for the open candidate
// (Gh), the files of the place and of the lock (FileSystem, Path), the processes the lock names
// (Pids), the project's configuration (ProjectConfig) and the terminal (Console).
// src/review/status.spec.ts runs it on in-memory layers.

import * as Console from 'effect/Console'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { projectBase } from '../base/base.ts'
import { candidateRules } from '../base/names.ts'
import { ProjectConfig } from '../config/load.ts'
import { printed } from '../exit.ts'
import { GhLive } from '../gh/gh.ts'
import { Git } from '../git/git.ts'
import { type Query, runQuery } from '../query.ts'
import { type Ledger, type ReviewState, reviewConfig, reviewCost } from '../review.ts'
import { branchesIn, ledgerPathIn, parseRefs, pruneReason, statePathIn } from '../review-store.ts'
import { runCommand } from '../run-command.ts'
import { SpawnerLive } from '../spawner.ts'
import type { Holder } from '../worktree/holder.ts'
import { heldBy, PidsLive } from '../worktree/lock.ts'
import { PlaceLive, placeOf } from './place.ts'
import { closedIn, legacyRounds, noRoundLine, stateView, summary, withDefaults } from './view.ts'

// A command as src/review-cli.ts parsed it.
export type StatusCommand =
  | { kind: 'status'; json: boolean; query?: string; clear: boolean; prune: boolean; dryRun: boolean }
  | { kind: 'cost'; json: boolean; query?: string }

// What status, cost, --clear or --prune refuses or cannot read: reported by its message, exit 1.
export class StatusFailed extends Data.TaggedError('StatusFailed')<{ message: string }> {}

// How a command ends: its exit code, or the query `after` runs.
export type Ending = { code: number } | { query: Query }

const out = (line: string) => Console.log(line)

const query = (document: unknown, expression: string, json: boolean, code: number): Query => ({
  input: JSON.stringify(document),
  expression,
  json,
  code,
  command: 'lntt review',
})

// "a", "a and b", "a, b and c".
export function listed(words: string[]): string {
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
}

// What a refusal or a status line calls the holder: its command, as the lock names it (a lock an
// older lntt wrote names none: a round).
const holderName = (holder: Holder): string => holder.command ?? 'a round'

// Each level of the state as its count, named as its key under `.state`: what is there to ask for
// with --query.
export function folded(state: ReviewState, view: ReturnType<typeof stateView>): string[] {
  const { result } = state
  return [
    `findings: ${result.findings.length} (${view.open.length} open)`,
    `refuted: ${result.refuted.length}`,
    `repeated: ${result.closed.length}`,
    `closed: ${view.closed.length}`,
    `failed: ${result.failed.length}`,
    `partial: ${result.partial.length}`,
    `skipped: ${result.skipped.length}`,
    `rounds: ${(state.rounds ?? []).length}`,
  ]
}

// A state file as status reads it: the state and when it was written, null when there is none, a
// StatusFailed when it is not a state (a write cut short, a hand edit), which --clear removes.
const readStatusState = Effect.fnUntraced(function* (dir: string, branch: string | null) {
  if (branch === null) return null
  const fs = yield* FileSystem.FileSystem
  const path = statePathIn(dir, branch)
  if (!(yield* fs.exists(path))) return null
  const text = yield* fs.readFileString(path)
  let state: ReviewState | null = null
  try {
    state = JSON.parse(text) as ReviewState
  } catch {}
  const result = state?.result as Partial<ReviewState['result']> | undefined
  if (
    state?.branch !== branch ||
    typeof state.round !== 'number' ||
    typeof result !== 'object' ||
    result === null ||
    !Array.isArray(result.findings)
  ) {
    return yield* new StatusFailed({
      message: `${path} cannot be read: pnpm exec lntt review status --clear removes it`,
    })
  }
  const info = yield* fs.stat(path)
  const updated = Option.getOrElse(info.mtime, () => new Date(0))
  return { state: withDefaults(state), updated }
})

// The ledger as it is on disk, whatever branch it names: {} when it cannot be read, null when
// there is none.
const ledgerFile = Effect.fnUntraced(function* (dir: string, branch: string) {
  const fs = yield* FileSystem.FileSystem
  const path = ledgerPathIn(dir, branch)
  if (!(yield* fs.exists(path))) return null
  try {
    return JSON.parse(yield* fs.readFileString(path)) as Partial<Ledger>
  } catch {
    return {} as Partial<Ledger>
  }
})

// A branch is merged when its tip (its local ref, else the head its last round read) is in the
// base every lntt command resolves (src/base/base.ts), which may ask GitHub for the open candidate.
// Null, with the reason, when that cannot be told: no base to compare with, a candidate GitHub
// could not name, no tip. Never a guess of "not merged".
const mergedInto = Effect.fnUntraced(function* (branch: string, head: string | null) {
  const git = yield* Git
  const data = yield* (yield* ProjectConfig).data
  const base = yield* projectBase(candidateRules(data), 'head').pipe(Effect.result)
  if (base._tag === 'Failure') {
    const said = String((base.failure as { message?: unknown }).message ?? base.failure).split('\n')[0]
    return { merged: null, why: `no base to compare with (${said})` }
  }
  if (base.success.warning) return { merged: null, why: base.success.warning }
  const ref = base.success.ref
  if ((yield* git.verify(`${ref}^{commit}`).pipe(Effect.orElseSucceed(() => null))) === null) {
    return { merged: null, why: `no base to compare with (${ref} is no commit)` }
  }
  const tip = (yield* git.verify(`refs/heads/${branch}^{commit}`).pipe(Effect.orElseSucceed(() => null))) ?? head
  if (!tip) return { merged: null, why: `no commit of ${branch} to compare with ${ref}` }
  const merged = yield* git.isAncestor(tip, ref)
  return merged ? { merged: true, why: `in ${ref}` } : { merged: false, why: `not in ${ref}` }
})

// The current branch's state, ledger and progress go once the branch is merged, or at once when
// its state cannot be read; never while a command holds the lock, and never the lock itself. The
// ledger of a branch that is not merged stays when only an unreadable state goes.
const clear = Effect.fnUntraced(function* (dir: string, gitDir: string, current: string | null) {
  const fs = yield* FileSystem.FileSystem
  const holder = yield* heldBy(gitDir)
  if (holder !== null) {
    return yield* new StatusFailed({
      message: `${holderName(holder)} is running in this worktree (pid ${holder.pid ?? 'starting'}): nothing cleared`,
    })
  }
  const read = yield* readStatusState(dir, current).pipe(
    Effect.map((own) => ({ own, unreadable: false })),
    Effect.catchTag('StatusFailed', () => Effect.succeed({ own: null, unreadable: true })),
  )
  const ledger = current === null ? null : yield* ledgerFile(dir, current)
  if (current === null || (!read.own && !read.unreadable && !ledger)) {
    yield* out('lntt review: nothing to clear')
    return 0
  }
  const check = yield* mergedInto(current, read.own?.state.result.head ?? null)
  const merged = check.merged === true
  if (!merged && !read.unreadable) {
    return yield* new StatusFailed({
      message:
        check.merged === null
          ? `the state is ${current}'s, the current branch, and whether it is merged cannot be told (${check.why}): nothing cleared`
          : `the state is ${current}'s, the current branch, and it is not merged (${check.why}): nothing cleared`,
    })
  }
  const removed: string[] = []
  const remove = Effect.fnUntraced(function* (name: string, path: string) {
    if (!(yield* fs.exists(path))) return
    yield* fs.remove(path)
    removed.push(name)
  })
  yield* remove('state', statePathIn(dir, current))
  if (merged) yield* remove('ledger', ledgerPathIn(dir, current))
  yield* remove('progress', `${gitDir}/lntt-review.progress`)
  yield* out(`lntt review: cleared ${read.unreadable ? 'an unreadable state: its' : `${current}'s`} ${listed(removed)}`)
  return 0
})

// The states and ledgers of branches that are gone: no local branch and no remote-tracking one of
// that name, or a local branch whose upstream is gone. A branch checked out in a worktree stays: a
// command may be running there. --dry-run says what would go.
const prune = Effect.fnUntraced(function* (dir: string, gitDir: string, dry: boolean) {
  const fs = yield* FileSystem.FileSystem
  const git = yield* Git
  const names = (folder: string) =>
    fs.readDirectory(`${dir}/${folder}`).pipe(Effect.orElseSucceed(() => [] as string[]))
  const refs = parseRefs(yield* git.branchRefs, yield* git.worktrees(gitDir))
  let gone = 0
  for (const branch of branchesIn(yield* names('state'), yield* names('ledger')).sort()) {
    const reason = pruneReason(branch, refs)
    if (reason === null) continue
    gone++
    const removed: string[] = []
    if (!dry) {
      for (const [name, path] of [
        ['state', statePathIn(dir, branch)],
        ['ledger', ledgerPathIn(dir, branch)],
      ] as const) {
        if (!(yield* fs.exists(path))) continue
        yield* fs.remove(path)
        removed.push(name)
      }
    }
    yield* out(
      `lntt review: ${dry ? 'would prune' : 'pruned'} ${branch} (${reason})${dry ? '' : `: ${listed(removed)}`}`,
    )
  }
  if (gone === 0) yield* out('lntt review: nothing to prune')
  return 0
})

// What the branch's rounds cost, from its state alone: the line the pull request's Review cost
// takes, or with --json each round and the total.
const cost = Effect.fnUntraced(function* (parsed: Extract<StatusCommand, { kind: 'cost' }>, home: string) {
  const git = yield* Git
  const { dir } = yield* placeOf(home)
  const branch = yield* git.branch
  const state = branch === 'HEAD' ? null : yield* readCostState(dir, branch)
  const rounds = state?.rounds ?? []
  const total = reviewCost(rounds, legacyRounds(state))
  const document = {
    branch,
    rounds,
    total: {
      rounds: total.rounds,
      tokens: total.tokens,
      usd: total.usd,
      unrecorded: total.unrecorded,
      line: total.line,
    },
  }
  if (parsed.query !== undefined) return { query: query(document, parsed.query, parsed.json, 0) } as Ending
  yield* out(parsed.json ? JSON.stringify(document, null, 2) : total.line)
  return { code: 0 } as Ending
})

// The state as a round reads it: one that names another branch, or is not JSON, cannot be read.
const readCostState = Effect.fnUntraced(function* (dir: string, branch: string) {
  const fs = yield* FileSystem.FileSystem
  const path = statePathIn(dir, branch)
  if (!(yield* fs.exists(path))) return null
  const text = yield* fs.readFileString(path)
  let state: ReviewState | null = null
  try {
    state = JSON.parse(text) as ReviewState | null
  } catch {
    return yield* new StatusFailed({
      message: `${path} cannot be read: pnpm exec lntt review status --clear removes it`,
    })
  }
  if (state?.branch !== branch)
    return yield* new StatusFailed({
      message: `${path} cannot be read: pnpm exec lntt review status --clear removes it`,
    })
  return state
})

// What `lntt review status` reads: the current branch's state, each level folded, one line of
// outcome and one per thing to act on; the whole of it with --json, a part with --query. The exit
// code says which: 0 clean, 1 something to act on, 3 at the limit, 4 no round on this branch.
const status = Effect.fnUntraced(function* (parsed: Extract<StatusCommand, { kind: 'status' }>, home: string) {
  const git = yield* Git
  const { dir } = yield* placeOf(home)
  const gitDir = yield* git.gitDir
  // The branch HEAD names, also before its first commit; null when HEAD is detached.
  const current = (yield* git.current) || null
  if (parsed.clear) return { code: yield* clear(dir, gitDir, current) } as Ending
  if (parsed.prune) return { code: yield* prune(dir, gitDir, parsed.dryRun) } as Ending
  // A lock created an instant ago names no pid yet: not a command running, for the summary as for
  // the JSON.
  const holder = yield* heldBy(gitDir)
  const running = holder?.pid ?? null
  const runningText = holder === null || running === null ? '' : `${holderName(holder)} is running (pid ${running})`
  const own = yield* readStatusState(dir, current)
  if (!own) {
    const line = noRoundLine(current ?? 'detached HEAD', runningText)
    const none = { branch: current, running, state: null }
    if (parsed.query !== undefined) {
      // With no state at all, a failure while running exits 4, there being no round to read, with
      // jq's message: the expression may be at fault too.
      const noRound = (exitCode: number) => (exitCode === 5 ? { code: 4, line } : null)
      return { query: { ...query(none, parsed.query, parsed.json, 4), onFailure: noRound } } as Ending
    }
    yield* out(parsed.json ? JSON.stringify(none, null, 2) : line)
    return { code: 4 } as Ending
  }
  const { state, updated } = own
  const result = state.result
  const { maxRounds } = reviewConfig(yield* (yield* ProjectConfig).data)
  const view = stateView(state, maxRounds, closedIn(yield* ledgerFile(dir, state.branch), state.branch))
  const code = view.clean ? 0 : view.atLimit ? 3 : 1
  if (!parsed.json && parsed.query === undefined) {
    yield* out([...folded(state, view), ...summary(state, view, runningText)].join('\n'))
    return { code } as Ending
  }
  const document = {
    branch: current,
    running,
    state: {
      branch: state.branch,
      // The place holds a branch's own state: it is always the current branch's.
      current: true,
      updated: updated.toISOString(),
      merged: (yield* mergedInto(state.branch, result.head)).merged,
      round: state.round,
      maxRounds,
      allowed: view.allowed,
      limit: view.limit,
      reviewed: state.reviewed,
      base: result.base,
      head: result.head,
      clean: view.clean,
      atLimit: view.atLimit,
      blocking: result.blocking,
      scope: result.scope,
      lenses: result.lenses,
      open: view.open,
      replied: view.replied,
      closed: view.closed,
      // The ledger's pre-existing entries: for the pull request body, apart from what blocks.
      preexisting: view.preexisting,
      failed: result.failed,
      partial: result.partial,
      skipped: result.skipped,
      tokens: view.tokens,
      cost: view.cost,
      // The last round whole, and the cost of each round.
      findings: result.findings,
      refuted: result.refuted,
      // Not `closed`, which is the ledger: the fresh findings that repeat an entry of it.
      repeated: result.closed,
      rounds: state.rounds ?? [],
    },
  }
  if (parsed.query !== undefined) return { query: query(document, parsed.query, parsed.json, code) } as Ending
  yield* out(JSON.stringify(document, null, 2))
  return { code } as Ending
})

const fail = (message: string) => Effect.as(Console.error(`lntt review: error: ${message}`), { code: 1 } as Ending)

// A command's ending: its exit code (1 for an expected failure, said in one line after `error:`,
// which the review skill watches for), or the query to run.
export const command = (parsed: StatusCommand, home: string) =>
  (parsed.kind === 'status' ? status(parsed, home) : cost(parsed, home)).pipe(
    Effect.catchTags({
      StatusFailed: (error) => fail(error.message),
      GitError: (error) => fail(error.message),
      PlaceInvalid: (error) => fail(error.message),
      ConfigInvalid: (error) => fail(error.message),
      PlatformError: (error) => fail(error.message),
    }),
  )

// The services on the machine: git, gh and the place's in the current directory, the lock's pids.
const Live = Layer.mergeAll(PlaceLive, GhLive.pipe(Layer.provide(SpawnerLive)), PidsLive)

// Runs a command as the process's main program (src/run-command.ts); a query runs once the runner
// has let go of the signals, as `after`.
export function runStatus(parsed: StatusCommand, home: string): Promise<never> {
  return runCommand(command(parsed, home).pipe(Effect.provide(Live)), {
    after: async (ending: Ending) => ('code' in ending ? ending.code : printed(await runQuery(ending.query))),
  })
}
