// `lntt review`: one review round on the current branch, or an answer to a reviewer
// (usage: bin/lntt.ts).

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { env, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import { projectBase } from './base.ts'
import { Exit, exit } from './exit.ts'
import { runQuery } from './query.ts'
import type { ReviewCommand } from './review/command.ts'
import { loaded, placeFor } from './review/host.ts'
import type { Place } from './review/place.ts'
import { closedIn, legacyRounds, noRoundLine, stateView, summary, withDefaults } from './review/view.ts'
import { formatTokens, type Ledger, type ReviewState, reviewConfig, reviewCost } from './review.ts'
import {
  branchesIn,
  ledgerPathIn,
  parseRefs,
  parseState,
  pruneReason,
  removeBranch,
  statePathIn,
} from './review-store.ts'
import { type Holder, heldBy } from './worktree-lock.ts'

export { formatTokens }

const USAGE = `usage: lntt review [--base <branch>] [--plan]
       lntt review reply <finding> <answer>
       lntt review allow <rounds>
       lntt review status [--json] [--query <jq>] [--clear | --prune [--dry-run]]
       lntt review cost [--json] [--query <jq>]`

export function usage(message?: string): never {
  if (message) stderr.write(`lntt review: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

export function git(...args: string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  })
    .toString()
    .trimEnd()
}

// Where each branch's state and ledger are kept between runs (src/review/host.ts): found once,
// on Effect, by status and cost once their arguments are read, before anything reads the place.
let placed: Place | null = null
async function findPlace(): Promise<void> {
  placed ??= await placeFor()
}
function place(): Place {
  if (placed === null) throw new Error('the place of the review state was read before it was found')
  return placed
}

function statePath(branch: string): string {
  return statePathIn(place().dir, branch)
}

function readState(branch: string): ReviewState | null {
  const path = statePath(branch)
  return existsSync(path) ? parseState(readFileSync(path, 'utf8'), path, branch) : null
}

function ledgerPath(branch: string): string {
  return ledgerPathIn(place().dir, branch)
}

// Where a round's progress goes (src/review/store.ts): status --clear removes it.
function progressPath(): string {
  return join(git('rev-parse', '--absolute-git-dir'), 'lntt-review.progress')
}

// The views of a state, with its branch's ledger.
const viewOf = (state: ReviewState, maxRounds: number) =>
  stateView(state, maxRounds, closedIn(ledgerFile(state.branch), state.branch))

// The lock's holder, null when nobody holds it.
function lockHolder(): Holder | null {
  return heldBy(git('rev-parse', '--absolute-git-dir'))
}

// What a refusal or a status line calls the holder: its command, as the lock names it (a lock
// an older lntt wrote names none: a round).
function holderName(holder: Holder): string {
  return holder.command ?? 'a round'
}

// What the branch's rounds cost, from its state alone: the line the pull request's Review
// cost takes, or with --json each round and the total.
async function cost(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { json: { type: 'boolean', default: false }, query: { type: 'string' } },
  })
  await findPlace()
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  const state = branch === 'HEAD' ? null : readState(branch)
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
  if (values.query !== undefined) return runQuery(query(document, values.query, values.json, 0))
  stdout.write(values.json ? `${JSON.stringify(document, null, 2)}\n` : `${total.line}\n`)
  return 0
}

// A state file that is not a state (a write cut short, a hand edit): `status` says so and
// `--clear` removes it, the only way out that does not open the git directory.
class UnreadableStateError extends Error {}

// The state as `lntt review status` reads it: an error when it cannot be read, never a
// round started on a guess.
function statusState(branch: string | null): { state: ReviewState; updated: Date } | null {
  if (branch === null) return null
  const path = statePath(branch)
  if (!existsSync(path)) return null
  let state: ReviewState
  try {
    state = JSON.parse(readFileSync(path, 'utf8')) as ReviewState
  } catch {
    state = null as unknown as ReviewState
  }
  const result = state?.result as Partial<ReviewState['result']> | undefined
  if (
    state?.branch !== branch ||
    typeof state.round !== 'number' ||
    typeof result !== 'object' ||
    result === null ||
    !Array.isArray(result.findings)
  )
    throw new UnreadableStateError(`${path} cannot be read: pnpm exec lntt review status --clear removes it`)
  return { state: withDefaults(state), updated: statSync(path).mtime }
}

// The ledger as it is on disk, whatever branch it names: {} when it cannot be read.
function ledgerFile(branch: string): Partial<Ledger> | null {
  const path = ledgerPath(branch)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Partial<Ledger>
  } catch {
    return {}
  }
}

// A branch is merged when its tip (its local ref, else the head its last round read) is
// in the base every lntt command resolves (src/base/base.ts), which may ask GitHub for the open
// candidate. Null, with the reason, when that cannot be told: no base to compare with, a
// candidate GitHub could not name, no tip. Never a guess of "not merged".
async function mergedInto(
  root: string,
  branch: string,
  head: string | null,
): Promise<{ merged: boolean | null; why: string }> {
  let ref: string
  try {
    const base = await projectBase(root, 'head')
    if (base.warning) return { merged: null, why: base.warning }
    ref = base.ref
    git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)
  } catch (error) {
    return { merged: null, why: `no base to compare with (${(error as Error).message.split('\n')[0]})` }
  }
  let tip = head
  try {
    tip = git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`)
  } catch {}
  if (!tip) return { merged: null, why: `no commit of ${branch} to compare with ${ref}` }
  try {
    git('merge-base', '--is-ancestor', tip, ref)
    return { merged: true, why: `in ${ref}` }
  } catch {
    return { merged: false, why: `not in ${ref}` }
  }
}

// "a", "a and b", "a, b and c".
function listed(words: string[]): string {
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
}

// The current branch's state, ledger and progress go once the branch is merged, or at once
// when its state cannot be read; never while a round holds the lock, and never the lock itself.
// The ledger of a branch that is not merged stays when only an unreadable state goes. The
// states of branches that no longer exist go with --prune.
async function clear(root: string, current: string | null): Promise<number> {
  const holder = lockHolder()
  if (holder !== null)
    throw new Error(
      `${holderName(holder)} is running in this worktree (pid ${holder.pid ?? 'starting'}): nothing cleared`,
    )
  let own: ReturnType<typeof statusState> = null
  let unreadable = false
  try {
    own = statusState(current)
  } catch (error) {
    if (!(error instanceof UnreadableStateError)) throw error
    unreadable = true
  }
  const ledger = current === null ? null : ledgerFile(current)
  if (current === null || (!own && !unreadable && !ledger)) {
    stdout.write('lntt review: nothing to clear\n')
    return 0
  }
  const check = await mergedInto(root, current, own?.state.result.head ?? null)
  const merged = check.merged === true
  if (!merged && !unreadable)
    throw new Error(
      check.merged === null
        ? `the state is ${current}'s, the current branch, and whether it is merged cannot be told (${check.why}): nothing cleared`
        : `the state is ${current}'s, the current branch, and it is not merged (${check.why}): nothing cleared`,
    )
  const removed: string[] = []
  const remove = (name: string, path: string) => {
    if (!existsSync(path)) return
    unlinkSync(path)
    removed.push(name)
  }
  remove('state', statePath(current))
  if (merged) remove('ledger', ledgerPath(current))
  remove('progress', progressPath())
  stdout.write(`lntt review: cleared ${unreadable ? 'an unreadable state: its' : `${current}'s`} ${listed(removed)}\n`)
  return 0
}

// The states and ledgers of branches that are gone: no local branch and no remote-tracking
// one of that name, or a local branch whose upstream is gone (GitHub deletes the head branch
// when it merges and the local one stays). A branch checked out in a worktree stays: a round
// may be running there. --dry-run says what would go.
function prune(dry: boolean): number {
  const dir = place().dir
  const refs = parseRefs(
    git('for-each-ref', '--format=%(refname)%09%(upstream:track)', 'refs/heads', 'refs/remotes'),
    git('worktree', 'list', '--porcelain'),
  )
  let gone = 0
  for (const branch of branchesIn(dir).sort()) {
    const reason = pruneReason(branch, refs)
    if (reason === null) continue
    gone++
    const removed = dry ? [] : removeBranch(dir, branch)
    stdout.write(
      `lntt review: ${dry ? 'would prune' : 'pruned'} ${branch} (${reason})${dry ? '' : `: ${listed(removed)}`}\n`,
    )
  }
  if (gone === 0) stdout.write('lntt review: nothing to prune\n')
  return 0
}

// Each level of the state as its count, named as its key under `.state`: what is there to ask
// for with --query.
function folded(state: ReviewState, view: ReturnType<typeof viewOf>): string[] {
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

// What `lntt review status` reads: the worktree's own state, through lntt review and
// never from its files, which live in each worktree's git directory. Each level folded, one
// line of outcome and one per thing to act on; the whole of it with --json, a part with
// --query. The exit code says which: 0 clean, 1 something to act on, 3 at the limit, 4 no
// round on this branch. It never takes the lock and never writes the progress file: a
// running round keeps both.
async function status(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      json: { type: 'boolean', default: false },
      clear: { type: 'boolean', default: false },
      prune: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      query: { type: 'string' },
    },
  })
  if (values.clear && values.json) usage('--clear does not take --json')
  if (values.clear && values.query !== undefined) usage('--clear does not take --query')
  if (values.prune && (values.clear || values.json || values.query !== undefined)) {
    usage('--prune takes only --dry-run')
  }
  if (values['dry-run'] && !values.prune) usage('--dry-run goes with --prune')
  await findPlace()
  const root = git('rev-parse', '--show-toplevel')
  // The branch HEAD names, also before its first commit; null when HEAD is detached.
  let current: string | null = null
  try {
    current = git('symbolic-ref', '--short', '-q', 'HEAD') || null
  } catch {}
  if (values.clear) return clear(root, current)
  if (values.prune) return prune(values['dry-run'])
  // A lock created an instant ago names no pid yet: not a round running, for the summary as
  // for the JSON; --clear still waits for it.
  const holder = lockHolder()
  const running = holder?.pid ?? null
  const runningText = holder === null || running === null ? '' : `${holderName(holder)} is running (pid ${running})`
  const own = statusState(current)
  const here = current ?? 'detached HEAD'
  if (!own) {
    const line = noRoundLine(here, runningText)
    const none = { branch: current, running, state: null }
    if (values.query !== undefined) {
      // With no state at all, a failure while running exits 4, there being no round to read,
      // with jq's message: the expression may be at fault too.
      const noRound = (exitCode: number) => (exitCode === 5 ? { code: 4, line } : null)
      return runQuery({ ...query(none, values.query, values.json, 4), onFailure: noRound })
    }
    stdout.write(values.json ? `${JSON.stringify(none, null, 2)}\n` : `${line}\n`)
    return 4
  }
  const { state, updated } = own
  const result = state.result
  const { maxRounds } = reviewConfig(loaded())
  const view = viewOf(state, maxRounds)
  const code = view.clean ? 0 : view.atLimit ? 3 : 1
  if (values.json || values.query !== undefined) {
    const out = {
      branch: current,
      running,
      state: {
        branch: state.branch,
        // The place holds a branch's own state: it is always the current branch's.
        current: true,
        updated: updated.toISOString(),
        merged: (await mergedInto(root, state.branch, result.head)).merged,
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
    if (values.query !== undefined) return runQuery(query(out, values.query, values.json, code))
    stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    return code
  }
  stdout.write(`${[...folded(state, view), ...summary(state, view, runningText)].join('\n')}\n`)
  return code
}

const query = (document: unknown, expression: string, json: boolean, code: number) => ({
  input: JSON.stringify(document),
  expression,
  json,
  code,
  command: 'lntt review',
})

export async function main([command, ...args]: string[]): Promise<void> {
  try {
    if (command === 'status') exit(await status(args))
    if (command === 'cost') exit(await cost(args))
    const parsed = parseCommand(command, args)
    // A round, a reply or allow holds the worktree's lock, a round or a reply its agents: they
    // run on Effect, which releases both however the command ends (src/review/command.ts).
    const { runReview } = await import('./review/command.ts')
    return runReview(parsed, homedir(), env)
  } catch (error) {
    await failed(error)
  }
}

// A round, a reply or allow, from its arguments: usage, exit 2, before Effect loads.
function parseCommand(command: string | undefined, args: string[]): ReviewCommand {
  if (command === 'reply') {
    const [id, ...words] = args
    if (!id || words.length === 0) usage('give the finding and the answer')
    return { kind: 'reply', id, answer: words.join(' ') }
  }
  if (command === 'allow') {
    const [count, ...rest] = args
    if (rest.length > 0 || !count || !/^\d+$/.test(count) || Number(count) < 1)
      usage('give the rounds to allow, a whole number from 1')
    return { kind: 'allow', rounds: Number(count) }
  }
  const { values } = parseArgs({
    args: command === undefined ? [] : [command, ...args],
    options: { base: { type: 'string' }, plan: { type: 'boolean', default: false } },
  })
  return { kind: 'round', base: values.base, plan: values.plan }
}

// The error report of status, cost or the arguments, then its exit: 1, or the code an exit()
// threw. A round, a reply and allow report their own (src/review/command.ts).
export async function failed(error: unknown): Promise<never> {
  if (error instanceof Exit) throw error
  if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')) {
    usage(error.message)
  }
  // `error:` is what the review skill watches for, with `failed`, `limit:` and `round N done`.
  stderr.write(`lntt review: error: ${error instanceof Error ? error.message : String(error)}\n`)
  exit(1)
}
