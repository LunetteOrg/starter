// `lntt retro add` on Effect (docs/adr/effect-in-lntt.md): one item under one label of the
// candidate's retrospective comment, or of the pull request --pr names. src/retro-cli.ts parses
// the arguments and loads this module when the command runs.
//
// The logic reaches the machine only through services: GitHub (Gh), the terminal (Console). The
// project's configuration is read at one place, `configured`, with the loader that is not yet on
// Effect (ProjectData, which a spec replaces). src/retro/command.spec.ts runs it on in-memory
// layers.

import * as Console from 'effect/Console'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { candidateNumber, openCandidateOf } from '../base/names.ts'
import type { CandidateConfig } from '../ci/candidate.ts'
import { exit } from '../exit.ts'
import { Gh, GhLive } from '../gh/gh.ts'
import { appendRetro, findLabel, type RetrospectiveRules, retroComment, retrospectiveBlock } from '../pull-request.ts'
import { ATTEMPTS, itemCount, sentenceOf } from '../retro.ts'
import { projectData } from '../retro-cli.ts'
import { runCommand } from '../run-command.ts'
import { SpawnerLive } from '../spawner.ts'

// A command as retro-cli.ts parsed it. `repository`: GITHUB_REPOSITORY, when it names one.
export interface RetroCommand {
  kind: 'add'
  label: string
  item: string
  pr?: number
  dryRun: boolean
  repository?: string
}

// What lntt retro reads of the project: the retrospective's labels, and delivery.candidate with
// the comment the candidate automation opens a candidate with (null without one: only --pr).
export interface RetroProject {
  rules: RetrospectiveRules
  candidate: { config: CandidateConfig; comment: string } | null
}

// An expected failure of lntt retro, reported by its message, exit 1: a refusal the person can act
// on (no label, no open candidate, an item that did not stay in the comment), a configuration the
// loader refuses.
export class RetroFailed extends Data.TaggedError('RetroFailed')<{ message: string }> {}

// The loader of the project's configuration, sync until it moves to Effect (#335).
export const ProjectData = Context.Reference<() => RetroProject>('@lntt/lntt/retro/command/ProjectData', {
  defaultValue: () => projectData,
})

const configured = Effect.flatMap(ProjectData, (load) =>
  Effect.try({
    try: load,
    catch: (cause) => new RetroFailed({ message: cause instanceof Error ? cause.message : String(cause) }),
  }),
)

// The text with the item appended; a body with no block or no line for the label is a refusal.
const appended = (text: string, label: string, sentence: string, rules: RetrospectiveRules) =>
  Effect.try({
    try: () => appendRetro(text, label, sentence, rules),
    catch: (cause) => new RetroFailed({ message: (cause as Error).message }),
  })

// The command line a dry run says it would run, as gh would be given it.
const shown = (args: string[]) => args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')

// Appends the item under the label it names, on the pull request --pr names or the open candidate.
// A candidate opened before the automation wrote the comment gets one, with the item in it. The
// comment is rewritten whole, so two appends at the same moment could drop one, and two creations
// make two comments: the comments are read again after the write, and the append done again on
// the retrospective comment when the item is not in it. Its pull request, its label and whether
// the comment that holds the item is one this run created.
export const retroAdd = Effect.fnUntraced(function* (project: RetroProject, parsed: RetroCommand, repo: string) {
  const { rules, candidate } = project
  const label = findLabel(rules, parsed.label)
  if (label === null)
    return yield* new RetroFailed({ message: `no label "${parsed.label}": one of ${rules.lines.join(', ')}` })
  const sentence = sentenceOf(parsed.item)
  if (sentence === '') return yield* new RetroFailed({ message: 'the item is empty: one sentence' })
  const gh = yield* Gh
  let number = parsed.pr
  if (number === undefined && candidate !== null) {
    const { prefix, base } = candidate.config
    const open = (yield* gh.openPullRequests({ repo, base, search: `head:${prefix}` }))
      .filter((pr) => candidateNumber(prefix, pr.headRefName) !== null)
      .sort((a, b) => (candidateNumber(prefix, a.headRefName) ?? 0) - (candidateNumber(prefix, b.headRefName) ?? 0))
    number = openCandidateOf(open, prefix)?.number
  }
  if (number === undefined) {
    const where =
      candidate === null ? 'no delivery.candidate' : `${candidate.config.prefix}<N> into ${candidate.config.base}`
    return yield* new RetroFailed({ message: `no open candidate (${where}): give the pull request with --pr <n>` })
  }
  const pr = number
  // A dry run says the write and writes nothing, so there is nothing to read back.
  const comment = (body: string) =>
    parsed.dryRun
      ? Console.log(
          `[dry-run] gh ${shown(['pr', 'comment', String(pr), '--repo', repo, '--body-file', '-'])}\n[dry-run] stdin:\n${body}`,
        )
      : gh.commentPullRequest({ repo, number: pr, body })
  const update = (id: number, body: string) =>
    parsed.dryRun
      ? Console.log(
          `[dry-run] gh ${shown(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${id}`, '--input', '-'])}\n[dry-run] stdin:\n${JSON.stringify({ body })}`,
        )
      : gh.updateComment({ repo, id, body })
  let created = false
  let before = 0
  // Each pass reads the comment: the first checks nothing, each later one checks the write before
  // it, and writes again when the item was dropped.
  for (let pass = 0; pass <= ATTEMPTS; pass++) {
    const found = retroComment(yield* gh.issueComments({ repo, number: pr }))
    if (pass > 0 && found !== null && itemCount(found.body, label, sentence) > before) return { pr, label, created }
    if (pass === ATTEMPTS) break
    if (found === null) {
      const empty = candidate === null ? retrospectiveBlock(rules) : candidate.comment
      yield* comment(yield* appended(empty, label, sentence, rules))
      created = true
      before = 0
    } else {
      created = false
      before = itemCount(found.body, label, sentence)
      yield* update(found.id, yield* appended(found.body, label, sentence, rules))
    }
    if (parsed.dryRun) return { pr, label, created }
  }
  return yield* new RetroFailed({
    message: `the item is not in the retrospective comment of #${pr} after ${ATTEMPTS} writes: another append ran at the same time; run it again`,
  })
})

// The command's exit code: 0, or 1 for any expected failure, said on one line.
export const command = (parsed: RetroCommand) =>
  Effect.gen(function* () {
    const project = yield* configured
    const repo = parsed.repository ?? (yield* (yield* Gh).repository)
    const { pr, label, created } = yield* retroAdd(project, parsed, repo)
    yield* Console.log(
      `retro: ${parsed.dryRun ? 'would add' : 'added'} under "${label}" on #${pr}${created ? ', in a new retrospective comment' : ''}.`,
    )
    return 0
  }).pipe(
    Effect.catchTags({
      RetroFailed: (error) => Effect.as(Console.error(`lntt retro: ${error.message}`), 1),
      GhError: (error) => Effect.as(Console.error(`lntt retro: ${error.message}`), 1),
    }),
  )

// The services on the machine.
const Live = GhLive.pipe(Layer.provide(SpawnerLive))

// Runs the command as the process's main program (src/run-command.ts): its exit code.
export function runRetro(parsed: RetroCommand): Promise<never> {
  return runCommand(command(parsed).pipe(Effect.map(exit), Effect.provide(Live)))
}
