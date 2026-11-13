// `lntt branch` on Effect (docs/adr/effect-in-lntt.md): the name an issue gets, the check of a
// branch, and the rename that fixes the name a tool gave it. src/branch-cli.ts parses the
// arguments and loads this module when the command runs.
//
// The logic reaches the machine only through services: git (Git), GitHub (Gh), Orca's CLI
// (ChildProcessSpawner), the terminal (Console). The project's configuration is read at one place,
// `configured`, with the loader that is not yet on Effect (ProjectData, which a spec replaces).
// src/branch/command.spec.ts runs it on in-memory layers.

import * as Console from 'effect/Console'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { ChildProcessSpawner } from 'effect/process'
import { candidateAt } from '../base/base.ts'
import {
  type BranchRules,
  branchName,
  branchRules,
  CANDIDATE_PREFIX,
  checkBranch,
  fromToolName,
  nameFromIssue,
  pushedBranches,
} from '../branch.ts'
import { projectData } from '../branch-cli.ts'
import { captured } from '../captured.ts'
import { exit } from '../exit.ts'
import { Gh, GhLive } from '../gh/gh.ts'
import { Git, GitLive } from '../git/git.ts'
import { runCommand } from '../run-command.ts'
import { SpawnerLive } from '../spawner.ts'
import type { Host } from '../viewer.ts'

// A command as branch-cli.ts parsed it.
export type BranchCommand =
  | { kind: 'name'; issue: number | null; type?: string; slug?: string }
  // `pushed`: the lines git gave the pre-push hook on stdin, when the check runs there.
  | { kind: 'check'; branch?: string; pushed?: string }
  // `host`: where the session runs; in Orca, the worktree's linked issue gives the name.
  | { kind: 'rename'; host: Host }

// An expected failure of `lntt branch`, reported by its message, exit 1.
export class BranchFailed extends Data.TaggedError('BranchFailed')<{ message: string }> {}

// The loader of the project's configuration (none is the defaults), sync until it moves to Effect.
export const ProjectData = Context.Reference<() => Record<string, unknown>>('@lntt/lntt/branch/command/ProjectData', {
  defaultValue: () => projectData,
})

// The project's configuration; one the loader refuses is a BranchFailed.
const configured = Effect.flatMap(ProjectData, (load) =>
  Effect.try({
    try: load,
    catch: (cause) => new BranchFailed({ message: cause instanceof Error ? cause.message : String(cause) }),
  }),
)

const say = (line: string) => Console.error(`lntt branch: ${line}`)

// The branch checked out; on a detached HEAD, the candidate whose origin/ ref points at it
// (delivery.candidate.prefix, else CANDIDATE_PREFIX as in branchRules), so a candidate's head is
// checked without a local branch named after it.
const currentBranch = Effect.fnUntraced(function* (data: Record<string, unknown>) {
  const git = yield* Git
  const current = yield* git.current
  if (current !== '') return current
  const delivery = data.delivery as { candidate?: { prefix?: string } } | undefined
  const prefix = delivery?.candidate?.prefix ?? CANDIDATE_PREFIX
  const candidate = yield* candidateAt(prefix)
  if (candidate === null) {
    return yield* new BranchFailed({
      message: `HEAD is detached and no origin/${prefix}<n> points at it: switch to a branch, or give --branch`,
    })
  }
  return candidate
})

// The issue Orca linked to this worktree, when the session runs in Orca; null when Orca does not
// say, whatever the reason.
const orcaIssue = Effect.fnUntraced(function* (host: Host) {
  if (host !== 'orca') return null
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const reply = yield* captured(spawner, 'orca', ['worktree', 'current', '--json']).pipe(
    Effect.map(({ out, code }) => {
      if (code !== 0) return null
      try {
        return JSON.parse(out) as { result?: { worktree?: { linkedIssue?: unknown } } }
      } catch {
        return null
      }
    }),
    Effect.orElseSucceed(() => null),
  )
  const issue = reply?.result?.worktree?.linkedIssue
  return typeof issue === 'number' ? issue : null
})

const name = Effect.fnUntraced(function* (parsed: Extract<BranchCommand, { kind: 'name' }>) {
  const overrides = {
    ...(parsed.type ? { type: parsed.type } : {}),
    ...(parsed.slug ? { slug: parsed.slug } : {}),
  }
  const result =
    parsed.issue === null
      ? branchName(parsed.type as string, null, parsed.slug as string)
      : nameFromIssue(parsed.issue, overrides, yield* (yield* Gh).issue(parsed.issue))
  const check = checkBranch(result, branchRules(yield* configured))
  if (!check.ok) {
    yield* say(`${result} is not a valid name: ${check.reason}; give --slug (or --type)`)
    return 1
  }
  yield* Console.log(result)
  return 0
})

const check = Effect.fnUntraced(function* (parsed: Extract<BranchCommand, { kind: 'check' }>) {
  const data = yield* configured
  const rules = branchRules(data)
  const branches =
    parsed.pushed === undefined ? [parsed.branch || (yield* currentBranch(data))] : pushedBranches(parsed.pushed)
  let failed = false
  for (const branch of branches) {
    const result = checkBranch(branch, rules)
    if (result.ok) continue
    const fix = result.expected
      ? `rename it: git branch -m ${result.expected}`
      : 'rename it to the name pnpm exec lntt branch name --issue <n> prints'
    yield* say(`${branch} does not follow type/issue/slug: ${result.reason}; ${fix}`)
    failed = true
  }
  return failed ? 1 : 0
})

// The name to rename to: read back from the name a tool gave, else built from Orca's linked issue.
// Null when neither gives one; an issue that cannot be read is said.
const target = Effect.fnUntraced(function* (current: string, rules: BranchRules, host: Host) {
  const fromTool = fromToolName(current, rules)
  if (fromTool) return fromTool
  const issue = yield* orcaIssue(host)
  if (issue === null) return null
  return yield* (yield* Gh).issue(issue).pipe(
    Effect.map((data) => nameFromIssue(issue, {}, data)),
    Effect.catchTag('GhError', (error) => Effect.as(say(`could not read issue #${issue}: ${error.message}`), null)),
  )
})

// Never fails on a name it cannot fix: it runs in a worktree's setup, where that is reported, not
// fatal. CI and the pre-push hook stop the branch if it stays wrong.
const rename = Effect.fnUntraced(function* (parsed: Extract<BranchCommand, { kind: 'rename' }>) {
  const git = yield* Git
  const current = yield* git.current
  if (current === '') {
    yield* say('HEAD is detached; nothing to rename')
    return 0
  }
  const rules = branchRules(yield* configured)
  if (checkBranch(current, rules).ok) return 0
  const next = yield* target(current, rules, parsed.host)
  if (next === null) {
    yield* say(
      `${current} does not follow type/issue/slug and holds nothing to rebuild it from; ` +
        'rename it with git branch -m "$(pnpm exec lntt branch name --issue <n>)"',
    )
    return 0
  }
  const valid = checkBranch(next, rules)
  if (!valid.ok) {
    yield* say(`${next}, built from the issue, is not a valid name: ${valid.reason}; ${current} stays`)
    return 0
  }
  if ((yield* git.verify(`refs/heads/${next}`)) !== null) {
    yield* say(`${next} already exists; ${current} stays as it is`)
    return 0
  }
  yield* git.renameBranch(next)
  yield* Console.log(`${current} → ${next}`)
  return 0
})

// A command's exit code: 0, 1 for a check that fails or any expected failure, said by its message.
export const command = (parsed: BranchCommand) =>
  Effect.gen(function* () {
    if (parsed.kind === 'name') return yield* name(parsed)
    if (parsed.kind === 'check') return yield* check(parsed)
    return yield* rename(parsed)
  }).pipe(
    Effect.catchTags({
      BranchFailed: (error) => Effect.as(say(error.message), 1),
      GitError: (error) => Effect.as(say(error.message), 1),
      GhError: (error) => Effect.as(say(error.message), 1),
    }),
  )

// The services on the machine.
const Live = Layer.mergeAll(GitLive, GhLive).pipe(Layer.provideMerge(SpawnerLive))

// Runs a command as the process's main program (src/run-command.ts): its exit code.
export function runBranch(parsed: BranchCommand): Promise<never> {
  return runCommand(command(parsed).pipe(Effect.map(exit), Effect.provide(Live)))
}
