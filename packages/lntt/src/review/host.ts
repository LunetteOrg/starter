// The sync code of lntt review that reaches the machine through modules not yet on Effect: the
// project's configuration, the place of the state store, the base, the agents' CLIs, the limit's
// message to the parent. No Effect at load: src/review-cli.ts (status, cost) calls it directly,
// and the live layer of the bridge (src/review/bridge.ts) calls it under Effect.try for the
// commands on Effect. Each piece leaves as its module moves.

import { cwd } from 'node:process'
import { projectBase } from '../base.ts'
import { type BranchRules, fromToolName } from '../branch.ts'
import { localRef } from '../ci/event.ts'
import { NoConfigError } from '../files.ts'
import { type HeadlessAgent as Agent, headlessInvocation } from '../headless.ts'
import { findConfig, loadConfig } from '../index.ts'
import { type Message, pending, type Started, send, startedBy } from '../messages.ts'
import { messagesRoot, systemMailbox } from '../messages-cli.ts'
import { loadOperator, slug } from '../operator.ts'
import { agentLabel } from '../review.ts'
import { migrateOld, type Place, resolvePlace } from '../review-store.ts'
import { commandExists } from '../viewer.ts'

// No configuration file: the defaults. A file that does not validate is an error: a
// review on the defaults would pass for the one the project configured.
export function loaded(): Record<string, unknown> {
  try {
    findConfig(cwd())
  } catch (error) {
    if (error instanceof NoConfigError) return {}
    throw error
  }
  return loadConfig(cwd()).data
}

// Where each branch's state and ledger are kept between runs: one file of each per branch,
// in the place the operator, the project or the clone names (src/review-store.ts). The first
// look also takes in what this worktree kept in its git directory before the place existed;
// `say` hears what that moved.
export function placeFor(
  common: string,
  gitDir: string,
  data: Record<string, unknown>,
  say: (line: string) => void,
): Place {
  const review = (data.delivery as { review?: { stateDir?: unknown } } | undefined)?.review
  const operator = (loadOperator(cwd()).profile.review as { stateDir?: unknown } | undefined)?.stateDir
  const placed = resolvePlace({
    common,
    main: common.endsWith('/.git') ? common.slice(0, -'/.git'.length) : common,
    slug: slug(cwd()),
    operator,
    project: review?.stateDir,
  })
  migrateOld(gitDir, placed.dir, say)
  return placed
}

// The ref the branch is compared with: --base as given (origin/<base>, else <base>), else the
// base every lntt command resolves (src/base.ts), which may ask GitHub for the open candidate;
// `said` is the line that names it.
export function baseRef(root: string, given: string | undefined): { ref: string; said: string | null } {
  if (given === undefined) {
    const base = projectBase(root, 'head')
    return { ref: base.ref, said: base.warning ?? `base ${base.reason}` }
  }
  const ref = localRef(root, given)
  if (ref === null)
    throw new Error(`no ${given} or origin/${given} to compare the branch with: run git fetch origin, or check --base`)
  return { ref, said: null }
}

// What keeps an agent from starting: a CLI that is not installed, or one that cannot be
// made read-only (headlessInvocation throws). A round refuses before any starts.
export function agentProblems(agents: Agent[]): string[] {
  const problems: string[] = []
  for (const agent of agents) {
    try {
      headlessInvocation(agent, '')
      if (!commandExists(agent.kind)) problems.push(`${agentLabel(agent)}: ${agent.kind} is not on the PATH`)
    } catch (error) {
      problems.push(`${agentLabel(agent)}: ${(error as Error).message}`)
    }
  }
  return problems
}

export type Asked = { id: string; to: string; path: string }

// Who the branch reports to, when `lntt worktree start` started it; null otherwise, and
// outside a git repository. A branch still on the name Orca gave it
// (`<user>/<type>-<issue>-<slug>`, until `lntt branch rename`) has the marker of its
// conventional name.
export function reportsTo(branch: string, rules: BranchRules): Started | null {
  try {
    const root = messagesRoot()
    const conventional = fromToolName(branch, rules)
    return (
      startedBy(root, branch) ??
      (conventional !== null && conventional !== branch ? startedBy(root, conventional) : null)
    )
  } catch {
    return null
  }
}

// The limit message of this branch still waiting for its answer in the directory it goes
// to: its first line names the branch.
function pendingLimit(root: string, marker: Started, branch: string): Message | undefined {
  const address = marker.to === 'coordinator' ? { theme: marker.theme as string } : {}
  return pending(root, marker.to, address).find((message) => {
    const first = message.question.split('\n')[0] ?? ''
    return /(^|-)review-limit(-\d+)?$/.test(message.topic) && first.split(' ').slice(0, 2).includes(`${branch}:`)
  })
}

// What is open goes to the coordinator or the orchestrator as a message the round does not
// wait for: it holds the review lock, and `lntt review allow` must stay possible while the
// answer is awaited. A limit already sent and not yet answered is not sent again: its id
// is the one to wait on. `asked` is null when the message cannot be written, which `line` says.
export function askAtLimit(marker: Started, branch: string, text: string): { asked: Asked | null; line: string } {
  const who = marker.to === 'coordinator' ? `the coordinator ${marker.theme}` : 'the orchestrator'
  const address = {
    ...(marker.to === 'coordinator' ? { theme: marker.theme as string } : {}),
    ...(marker.issue === null ? {} : { issue: marker.issue }),
  }
  try {
    const box = systemMailbox()
    const earlier = pendingLimit(box.dir, marker, branch)
    const sent = earlier ?? send(box, marker.to, text, { topic: 'review-limit', ...address })
    return {
      asked: { id: sent.id, to: marker.to, path: sent.path },
      line: `limit: ${earlier ? 'already sent' : 'sent'} ${sent.id} to ${who}; wait with: pnpm exec lntt ask --wait ${sent.id}`,
    }
  } catch (error) {
    return { asked: null, line: `limit: could not send to ${who}: ${(error as Error).message}` }
  }
}
