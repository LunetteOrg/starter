// `lntt worktree start` on Effect (docs/adr/effect-in-lntt.md): an agent on an issue, in its own
// worktree, on the host the session runs in. src/worktree-cli.ts parses the arguments and reads
// the environment and the context file, then loads this module.
//
// The logic reaches the machine only through services: git (Git), GitHub (Gh), the hosts' CLIs and
// the setup (ChildProcessSpawner, through src/worktree/steps.ts), the files (FileSystem), the agents'
// mailbox (Mailbox), the project's configuration (ProjectConfig), the terminal (Console), the
// clock of the gate's wait (Clock). src/worktree/start.spec.ts runs it on in-memory layers.

import * as NodeFileSystem from '@effect/platform-node-shared/NodeFileSystem'
import * as Console from 'effect/Console'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import { ChildProcessSpawner } from 'effect/process'
import { localRef, projectBase } from '../base/base.ts'
import { branchName, branchRules, checkBranch, nameFromIssue } from '../branch.ts'
import { captured } from '../captured.ts'
import { isHotfix } from '../ci/candidate.ts'
import { candidateConfigOf } from '../ci/config.ts'
import { ProjectConfig, ProjectConfigLive } from '../config/load.ts'
import { exit } from '../exit.ts'
import { Gh, GhLive } from '../gh/gh.ts'
import { Git, GitLive } from '../git/git.ts'
import {
  forgetStarted,
  mailboxIn,
  mailboxRoot,
  recordStarted,
  send,
  startedBy,
  waitForAnswer,
} from '../messages/mailbox.ts'
import type { Started as Marker } from '../messages/rules.ts'
import { runCommand } from '../run-command.ts'
import { SpawnerLive } from '../spawner.ts'
import {
  agentFor,
  approvals,
  approve,
  type Config,
  childBrief,
  coordinatorBrief,
  gateOf,
  isApproval,
} from './coordinator.ts'
import {
  type Agent,
  agentArgs,
  renderBrief,
  type Start,
  shellLaunch,
  startOn,
  type Templates,
  type WorktreeHost,
} from './hosts.ts'
import { runSteps } from './steps.ts'

// A command as src/worktree-cli.ts parsed it: its flags checked, the context file read.
export interface StartCommand {
  issues: number[]
  host: WorktreeHost
  given: Partial<Agent>
  noAgent: boolean
  base?: string
  prompt?: string
  coordinator: boolean
  theme?: string
  approve: number[]
  parent?: string
  context?: string
  size?: string
  workflow: boolean
  // How often the gate's wait looks for the orchestrator's answer.
  pollMs: number
}

// What `lntt worktree start` refuses: reported by its message, exit 1.
export class StartFailed extends Data.TaggedError('StartFailed')<{ message: string }> {}

const plain = <A>(run: () => A) =>
  Effect.try({
    try: run,
    catch: (error) => new StartFailed({ message: error instanceof Error ? error.message : String(error) }),
  })

// lntt's agents/, where the briefs' templates are: next to src/ in the package and in dist/.
export const AgentsDir = Context.Reference<string>('@lntt/lntt/worktree/start/AgentsDir', {
  defaultValue: () => decodeURIComponent(new URL('../../agents', import.meta.url).pathname),
})

const templates = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* AgentsDir
  const names = (yield* fs.readDirectory(dir)).filter((name) => name.endsWith('.md'))
  const read: Templates = {}
  for (const name of names) read[name] = yield* fs.readFileString(`${dir}/${name}`)
  return read
})

const say = (line: string) => Console.error(`lntt worktree: ${line}`)

// --prompt: instructions of one's own, after the whole brief.
export function withPrompt(brief: string, prompt: string | undefined): string {
  if (!prompt?.trim()) return brief
  return `${brief.trimEnd()}\n\n## Added at start\n\n${prompt.trim()}\n`
}

// Who the agent started on a branch reports to, for `lntt review` at its limit: a coordinator to
// the orchestrator, a child of a theme to its coordinator, a plain issue to the orchestrator, and
// so is a child of a theme that has no coordinator.
export function marker(job: Start, coordinator: boolean, theme: string | undefined, coordinated: boolean): Marker {
  if (coordinator) return { branch: job.branch, issue: null, to: 'orchestrator', theme: theme as string }
  if (theme && coordinated) return { branch: job.branch, issue: job.issue, to: 'coordinator', theme }
  return { branch: job.branch, issue: job.issue, to: 'orchestrator' }
}

// A marker that cannot be written costs the review limit its message, not the start: it is said.
const recordMarker = (started: Marker) =>
  Effect.flatMap(mailboxRoot, (root) => recordStarted(root, started)).pipe(
    Effect.catch((error) =>
      Console.error(`lntt worktree start: could not record who ${started.branch} reports to: ${error.message}`),
    ),
  )

// The main checkout, also from a linked worktree: new worktrees go next to the others.
const mainCheckout = Effect.map(
  Effect.flatMap(Git, (git) => git.commonDir),
  (common) => common.replace(/\/\.git$/, ''),
)

// The orca binary by absolute path, which every brief uses: a PATH that reaches it from one
// session does not from another. Null when Orca is not the host, or the shell does not find it.
const orcaPath = (host: WorktreeHost) =>
  host !== 'orca'
    ? Effect.succeed(null)
    : Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
        captured(spawner, 'sh', ['-c', 'command -v orca']),
      ).pipe(
        Effect.map(({ out, code }) => (code === 0 && out.trim() ? out.trim() : null)),
        Effect.orElseSucceed(() => null),
      )

// What every host branches from: --base as given (origin/<base>, else <base>: a sibling's branch
// may exist only here), else the base every lntt command resolves (src/base/base.ts), asked once
// per kind: a hotfix (branch prefix or label) stays on the default branch.
const startBase = Effect.fnUntraced(function* (given: string | undefined, data: Record<string, unknown>) {
  const context = yield* Effect.context<Git | Gh>()
  if (given !== undefined) {
    const ref = (yield* localRef(given)) ?? given
    return (_hotfix: boolean) => Effect.succeed(ref)
  }
  const candidate = candidateConfigOf(data)
  const rules = candidate ? { base: candidate.base, prefix: candidate.prefix } : null
  const resolved = new Map<boolean, string>()
  return (hotfix: boolean) =>
    Effect.gen(function* () {
      const known = resolved.get(hotfix)
      if (known !== undefined) return known
      const base = yield* projectBase(rules, hotfix ? 'hotfix' : 'new')
      yield* say(base.warning ?? `base ${base.reason}`)
      resolved.set(hotfix, base.ref)
      return base.ref
    }).pipe(Effect.provideContext(context))
})

// A coordinator's child waits for the person's go before anything is created, unless the theme's
// approved list already has it: the gate is the project's setting (coordinator.gate), not a
// sentence in a brief. The proposal is one message for the batch.
const passTheGate = Effect.fnUntraced(function* (
  config: Config,
  theme: string,
  jobs: Start[],
  size: string | undefined,
  pollMs: number,
) {
  if (gateOf(config) === 'free') return
  const root = yield* mailboxRoot
  const approved = yield* approvals(root, theme)
  const proposed = jobs.filter((job) => job.issue !== null && !approved.has(job.issue))
  if (proposed.length === 0) return
  const list = proposed.map((job) => `- #${job.issue}: ${job.title} (on ${job.base})`).join('\n')
  const issues = proposed.map((job) => job.issue as number)
  const sent = yield* send(
    root,
    'orchestrator',
    `Coordinator ${theme} proposes to start${size ? ` (size ${size})` : ''}:\n${list}\nAnswer "approve" (or "yes", "ok") alone to start; anything else declines.`,
    { topic: `start-${issues.join('-')}` },
  )
  yield* say(`${sent.id} sent to the orchestrator; no child is created until it approves`)
  const reply = yield* waitForAnswer(sent, { intervalMs: pollMs })
  if (!isApproval(reply))
    return yield* new StartFailed({ message: `not approved by the orchestrator: ${reply.trim()}` })
  yield* approve(root, theme, issues)
})

// Whether the theme has a coordinator worktree: the one `lntt worktree start --coordinator` left
// its marker for. A child started with --theme for the context and the Size alone has none, and
// reports to the orchestrator.
const hasCoordinator = Effect.fnUntraced(function* (theme: string) {
  const found = yield* startedBy(yield* mailboxRoot, branchName('chore', null, theme))
  return found?.issue === null && found.theme === theme
})

const start = Effect.fnUntraced(function* (parsed: StartCommand) {
  const { host, coordinator, theme } = parsed
  const data = yield* (yield* ProjectConfig).data
  const config = data as Config
  const agent = yield* plain(() =>
    coordinator
      ? agentFor(config, { role: 'coordinator' }, parsed.given)
      : agentFor(config, { role: 'child', ...(parsed.size ? { size: parsed.size } : {}) }, parsed.given),
  )
  // Refused before anything is created: what the agent cannot take.
  yield* plain(() => {
    agentArgs(agent)
    shellLaunch(agent)
  })
  const root = yield* mainCheckout
  const base = yield* startBase(parsed.base, data)
  const candidate = candidateConfigOf(data)
  const ruleset = branchRules(data)
  const orca = yield* orcaPath(host)
  const brief = yield* templates
  const wherever = (branch: string) =>
    host === 'orca' ? 'the worktree this session starts in' : `${root}/.worktrees/${branch.replace(/\//g, '-')}`
  const launched = parsed.noAgent || host === 'git' ? null : agent
  const gh = yield* Gh

  // Every issue is read and named before anything is created: a batch either starts whole or not
  // at all.
  const jobs: Start[] = []
  const coordinated = theme !== undefined && (yield* hasCoordinator(theme))
  if (theme && !coordinator && !coordinated) {
    yield* Console.error(
      `lntt worktree start: theme ${theme} has no coordinator worktree: the children report to the orchestrator`,
    )
  }
  if (coordinator) {
    const themeName = theme as string
    const branch = branchName('chore', null, themeName)
    const check = checkBranch(branch, ruleset)
    if (!check.ok) return yield* new StartFailed({ message: `${branch} is not a valid name: ${check.reason}` })
    const listed = []
    for (const issue of parsed.issues) listed.push({ issue, title: (yield* gh.issue(issue)).title })
    jobs.push({
      issue: null,
      title: `Theme ${themeName}`,
      branch,
      base: yield* base(false),
      agent: launched,
      root,
      brief: withPrompt(
        coordinatorBrief(brief, {
          theme: themeName,
          worktree: wherever(branch),
          branch,
          issues: listed,
          approved: parsed.approve,
          config,
          orca,
        }),
        parsed.prompt,
      ),
    })
  } else {
    for (const issue of parsed.issues) {
      const data = yield* gh.issue(issue)
      const branch = nameFromIssue(issue, {}, data)
      const check = checkBranch(branch, ruleset)
      if (!check.ok)
        return yield* new StartFailed({ message: `#${issue}: ${branch} is not a valid name: ${check.reason}` })
      const worktree = wherever(branch)
      const common = { issue, title: data.title, branch, worktree }
      const hotfix =
        candidate !== null && isHotfix(candidate, { headRef: branch, labels: data.labels.map((l) => l.name) })
      jobs.push({
        issue,
        title: data.title,
        branch,
        base: yield* base(hotfix),
        agent: launched,
        root,
        ...(parsed.parent ? { parent: parsed.parent } : {}),
        brief: withPrompt(
          yield* plain(() =>
            theme
              ? childBrief(brief, common, {
                  theme,
                  coordinator: coordinated,
                  ...(parsed.context ? { context: parsed.context } : {}),
                  workflow: parsed.workflow,
                  orca,
                })
              : renderBrief(brief, undefined, common),
          ),
          parsed.prompt,
        ),
      })
    }
  }
  if (coordinator && parsed.approve.length > 0) yield* approve(yield* mailboxRoot, theme as string, parsed.approve)
  // The gate is the coordinator's: with none, the orchestrator is the one starting.
  if (!coordinator && theme && coordinated) yield* passTheGate(config, theme, jobs, parsed.size, parsed.pollMs)

  for (const job of jobs) {
    // Before the host starts: a start that fails once the worktree exists still leaves it. A second
    // start of a coordinator that fails must not take the live one's marker with it.
    const earlier = coordinator ? yield* startedBy(yield* mailboxRoot, job.branch) : null
    yield* recordMarker(marker(job, coordinator, theme, coordinated))
    const started = yield* runSteps(startOn(host, job)).pipe(
      // A coordinator whose start failed is none: later children of the theme must not wait on it.
      // The marker of an earlier start of it stays.
      Effect.tapError(() =>
        !coordinator
          ? Effect.void
          : earlier
            ? recordMarker(earlier)
            : Effect.flatMap(mailboxRoot, (root) => forgetStarted(root, job.branch)).pipe(Effect.ignore),
      ),
    )
    yield* Console.log(JSON.stringify(started))
    // Nobody was asked to start an agent: the command and the brief are for the person who will.
    if (job.agent === null) {
      const launch = shellLaunch(agent) ?? [agent.kind, ...agentArgs(agent)].join(' ')
      const command = host === 'git' ? `${launch}  # in ${started.path}\n\n` : ''
      yield* Console.log(`\n${command}${job.brief}`)
    }
  }
  return 0
})

// The command's exit code: 0, or 1 for any expected failure, said by its message.
export const command = (parsed: StartCommand) => {
  const failed = (error: { message: string }) => Effect.as(say(error.message), 1)
  return start(parsed).pipe(
    Effect.catchTags({
      StartFailed: failed,
      ToolFailed: failed,
      MailboxFailed: failed,
      GhError: failed,
      GitError: failed,
      BaseError: failed,
      ConfigInvalid: failed,
      PlatformError: failed,
    }),
  )
}

// The services on the machine; `messagesDir` is LNTT_MESSAGES_DIR.
const live = (messagesDir: string | undefined) =>
  mailboxIn(messagesDir).pipe(
    Layer.provideMerge(Layer.mergeAll(GitLive, GhLive, ProjectConfigLive)),
    Layer.provideMerge(Layer.mergeAll(SpawnerLive, NodeFileSystem.layer, Path.layer)),
  )

// Runs the command as the process's main program (src/run-command.ts): its exit code.
export function runStart(parsed: StartCommand, messagesDir: string | undefined): Promise<never> {
  return runCommand(command(parsed).pipe(Effect.map(exit), Effect.provide(live(messagesDir))))
}
