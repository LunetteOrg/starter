// `lntt issue` on Effect (docs/adr/effect-in-lntt.md): a report on Lunette itself, printed for
// the operator to read (a dry run, the default) and filed on the upstream repository with --send;
// `lntt issue search`, the open issues a draft would repeat. src/issue-cli.ts parses the arguments
// and loads this module when the command runs.
//
// The logic reaches the machine only through services: GitHub (Gh), git (Git, the origin remote),
// the file system (the draft, a saved dump, the project's package.json), the terminal (Console).
// What is not yet on Effect is read at one place, IssueBridge, whose default is the sync code (the
// project's configuration and root, lntt dump's collection and redaction, #335 and #341) and which
// a spec replaces. src/issue/command.spec.ts runs it on in-memory layers.

import * as NodeFileSystem from '@effect/platform-node-shared/NodeFileSystem'
import * as Console from 'effect/Console'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import { repositoryOf } from '../base/names.ts'
import { type Dump, type Redaction, redact, withAgent } from '../dump.ts'
import { exit } from '../exit.ts'
import { Gh, GhLive } from '../gh/gh.ts'
import { Git, GitLive } from '../git/git.ts'
import {
  bodyTooLong,
  type Draft,
  IssueError,
  issueBody,
  parseDraft,
  sameRepository,
  upstreamRepository,
} from '../issue.ts'
import { issueBridge } from '../issue-cli.ts'
import { runCommand } from '../run-command.ts'
import { SpawnerLive } from '../spawner.ts'

type Env = Record<string, string | undefined>

// A command as issue-cli.ts parsed it. `draft`: the text read from stdin, or the file to read.
export type IssueCommand =
  | { kind: 'search'; words: string; repo?: string; env: Env }
  | {
      kind: 'file'
      draft: { text: string } | { path: string }
      repo?: string
      dump?: string
      harness?: string
      model?: string
      project?: string
      comment?: number
      send: boolean
      env: Env
    }

// What lntt issue reads with the code not yet on Effect.
export interface IssueBridgeService {
  // The project's root (the directory of .agents/, else the current one) and its configuration
  // (none: the defaults).
  readonly project: () => { root: string; config: Record<string, unknown> }
  // lntt dump's collection of the environment, and what it redacts.
  readonly collect: (input: { root: string; env: Env; harness?: string; model?: string }) => Dump
  readonly redaction: (root: string, env: Env) => Redaction
}

export const IssueBridge = Context.Reference<IssueBridgeService>('@lntt/lntt/issue/command/IssueBridge', {
  defaultValue: () => issueBridge,
})

// An expected failure of lntt issue, reported on one line, exit 1: a refusal with a reason the
// person can act on, a file that cannot be read, a gh that fails.
export class IssueFailed extends Data.TaggedError('IssueFailed')<{ message: string }> {}

// What the sync code gives; what it throws is an IssueFailed with its message.
const bridged = <A>(f: (bridge: IssueBridgeService) => A) =>
  Effect.flatMap(IssueBridge, (bridge) =>
    Effect.try({
      try: () => f(bridge),
      catch: (cause) => new IssueFailed({ message: cause instanceof Error ? cause.message : String(cause) }),
    }),
  )

// The plain logic's refusals (IssueError) as IssueFailed.
const refused = <A>(f: () => A) =>
  Effect.try({
    try: f,
    catch: (cause) => new IssueFailed({ message: (cause as IssueError).message }),
  })

const say = (line: string) => Console.error(`lntt issue: ${line}`)

// The configured upstream; null instead of the refusal when it may be missing.
const upstreamOrNone = (config: Record<string, unknown>, lenient: boolean) =>
  Effect.suspend(() => {
    try {
      return Effect.succeed<string | null>(upstreamRepository(config))
    } catch (error) {
      if (lenient && error instanceof IssueError) return Effect.succeed(null)
      return Effect.fail(new IssueFailed({ message: (error as Error).message }))
    }
  })

// The repository the command runs in: GITHUB_REPOSITORY in Actions, else the origin remote's,
// read from git with no network call (gh repo view would follow gh's default repository, the
// upstream in a fork). Null when neither tells: a report to it is no report, its items are
// handled here.
const currentRepository = (env: Env) =>
  env.GITHUB_REPOSITORY
    ? Effect.succeed<string | null>(env.GITHUB_REPOSITORY)
    : Effect.flatMap(Git, (git) => git.originUrl).pipe(
        Effect.map((url) => repositoryOf(url || null)),
        Effect.orElseSucceed(() => null),
      )

const readText = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path)).pipe(
    Effect.mapError((error) => new IssueFailed({ message: error.message })),
  )

// A dump saved by lntt dump --json.
const readDump = (path: string) =>
  Effect.flatMap(readText(path), (text) =>
    Effect.suspend(() => {
      let data: Partial<Dump>
      try {
        data = JSON.parse(text) as Partial<Dump>
      } catch {
        data = {}
      }
      if (!Array.isArray(data.sections) || typeof data.harness !== 'string' || typeof data.model !== 'string') {
        return Effect.fail(new IssueFailed({ message: `${path} is not a dump of lntt dump --json` }))
      }
      return Effect.succeed(data as Dump)
    }),
  )

// The project's name: its package.json's, else its directory's.
const projectName = (root: string) =>
  readText(`${root}/package.json`).pipe(
    Effect.map((text) => {
      try {
        const name = JSON.parse(text).name
        return typeof name === 'string' && name !== '' ? name : null
      } catch {
        return null
      }
    }),
    Effect.orElseSucceed(() => null),
    Effect.map((name) => name ?? (root.split('/').filter(Boolean).at(-1) || root)),
  )

// Prints a text that ends with a newline, as it is.
const printed = (text: string) => Console.log(text.endsWith('\n') ? text.slice(0, -1) : text)

const search = Effect.fnUntraced(function* (parsed: Extract<IssueCommand, { kind: 'search' }>) {
  const { config } = yield* bridged((bridge) => bridge.project())
  // Lunette's repository, where reports are sent; --repo names another one.
  const upstream = yield* upstreamOrNone(config, parsed.repo !== undefined)
  const repo = parsed.repo ?? (upstream as string)
  for (const found of yield* (yield* Gh).searchIssues({ repo, words: parsed.words })) {
    yield* Console.log(JSON.stringify(found))
  }
  return 0
})

const file = Effect.fnUntraced(function* (parsed: Extract<IssueCommand, { kind: 'file' }>) {
  const { root, config } = yield* bridged((bridge) => bridge.project())
  // Lunette's repository, where reports are sent; --repo names another one (a library the project
  // uses), whose report is only printed, for the operator to file by hand: that one needs no
  // upstream, --send does.
  const upstream = yield* upstreamOrNone(config, parsed.repo !== undefined && !parsed.send)
  const repo = parsed.repo ?? (upstream as string)
  const toUpstream = sameRepository(repo, upstream)
  const text = 'text' in parsed.draft ? parsed.draft.text : yield* readText(parsed.draft.path)
  const draft: Draft = yield* refused(() => parseDraft(text))
  if (parsed.send && !toUpstream) {
    return yield* new IssueFailed({
      message: `${repo} is not cycle.retrospective.upstream.repository (${upstream}): only that one is sent; the operator files this report by hand`,
    })
  }
  // Lunette's own repository reports to itself: its items are handled here, by the harvest.
  const current = yield* currentRepository(parsed.env)
  if (toUpstream && sameRepository(current, upstream)) {
    yield* say(`nothing to send: ${upstream} is this repository (${current}), the harvest handles its items here`)
    return 0
  }
  const given = {
    ...(parsed.harness === undefined ? {} : { harness: parsed.harness }),
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
  }
  const dump =
    parsed.dump === undefined
      ? yield* bridged((bridge) => bridge.collect({ root, env: parsed.env, ...given }))
      : withAgent(yield* readDump(parsed.dump), given)
  // The draft and the project's name leave the machine too: redacted as the dump is.
  const redaction = yield* bridged((bridge) => bridge.redaction(root, parsed.env))
  const title = redact(draft.title, redaction)
  const body = redact(issueBody(draft, dump, parsed.project ?? (yield* projectName(root))), redaction)
  // A comment has no title.
  const tooLong = bodyTooLong(parsed.comment === undefined ? title : '', body)

  if (!parsed.send) {
    const where = parsed.comment === undefined ? `To ${repo}: ${title}` : `To ${repo}#${parsed.comment}, as a comment`
    yield* printed(`${where}\n\n${body}`)
    if (tooLong) yield* say(tooLong)
    yield* say(
      toUpstream
        ? 'nothing sent: --send opens it, once the operator has read it'
        : `nothing sent: ${repo} is not the upstream, the operator files it by hand`,
    )
    return 0
  }
  if (tooLong) return yield* new IssueFailed({ message: tooLong })
  const gh = yield* Gh
  const url =
    parsed.comment === undefined
      ? yield* gh.createIssue({ repo, title, body })
      : yield* gh.commentIssue({ repo, number: parsed.comment, body })
  yield* Console.log(url)
  return 0
})

// The command's exit code: 0, or 1 for any expected failure, said on one line.
export const command = (parsed: IssueCommand) =>
  (parsed.kind === 'search' ? search(parsed) : file(parsed)).pipe(
    Effect.catchTags({
      IssueFailed: (error) => Effect.as(say(error.message), 1),
      GhError: (error) => Effect.as(say(error.message), 1),
    }),
  )

// The services on the machine.
const Live = Layer.mergeAll(GhLive, GitLive, NodeFileSystem.layer).pipe(Layer.provideMerge(SpawnerLive))

// Runs the command as the process's main program (src/run-command.ts): its exit code.
export function runIssue(parsed: IssueCommand): Promise<never> {
  return runCommand(command(parsed).pipe(Effect.map(exit), Effect.provide(Live)))
}
