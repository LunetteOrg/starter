// `lntt board sync` and `lntt board ready` on Effect (docs/adr/effect-in-lntt.md). src/board-cli.ts
// parses the arguments and loads this module when the command runs.
//
// The logic reaches the machine only through services: GitHub (Gh), the project's configuration
// (ProjectConfig), the clock (the pause between two writes, which a spec moves with TestClock), the
// terminal (Console). src/board/command.spec.ts runs it on in-memory layers.

import * as NodeFileSystem from '@effect/platform-node-shared/NodeFileSystem'
import * as NodePath from '@effect/platform-node-shared/NodePath'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { type BoardConfig, describeStep, type Manual, PAUSE_MS, planBoard } from '../board.ts'
import { holdsLine, type ProjectIssue, type ReadyRules, readyRules } from '../board-ready.ts'
import { ProjectConfig, ProjectConfigLive } from '../config/load.ts'
import { getValue } from '../config/project.ts'
import { exit } from '../exit.ts'
import { Gh, type GhError, GhLive } from '../gh/gh.ts'
import { runCommand } from '../run-command.ts'
import { SpawnerLive } from '../spawner.ts'
import {
  applyStep,
  BoardFailed,
  countRemovals,
  type ProjectRef,
  planned,
  type Removal,
  readBoard,
  removalKey,
} from './github.ts'
import { moveToReady, readFirstStatus } from './ready.ts'

// A command as board-cli.ts parsed it. `repository`: GITHUB_REPOSITORY, when it names one.
export type BoardCommand =
  | { kind: 'sync'; mode: 'dry run' | 'apply' | 'check' }
  | { kind: 'ready'; apply: boolean; repository?: string }

// What `pick` reads of the project's configuration (the defaults with no file); one that does not
// validate, or a key `pick` finds missing, is a BoardFailed.
const configured = <A>(pick: (data: Record<string, unknown>) => A) =>
  Effect.flatMap(ProjectConfig, (config) => config.data).pipe(
    Effect.flatMap((data) => Effect.try({ try: () => pick(data), catch: (cause) => cause })),
    Effect.mapError((cause) => new BoardFailed({ message: cause instanceof Error ? cause.message : String(cause) })),
  )

// What a failure of GitHub says: gh's own message.
const said = (error: GhError | BoardFailed) =>
  error._tag === 'GhError' ? error.output || error.message : error.message

const lines = (text: string) => Effect.forEach(text.replace(/\n$/, '').split('\n'), (line) => Console.log(line))

const printManual = (manual: Manual[]) => {
  if (manual.length === 0) return Effect.void
  const entry = (m: Manual) =>
    `  ${m.what}: ${m.why}\n${m.url ? `    ${m.url}\n` : ''}${m.steps.map((s, i) => `    ${i + 1}. ${s}\n`).join('')}`
  return lines(`by hand, in GitHub's UI:\n${manual.map(entry).join('')}`)
}

// The plan from the board GitHub shows: planned once to learn which removals it has, whose counts
// are read only then, and again with them. It holds because planBoard lists the same removals
// whatever the counts: a count only enters the text of a manual entry. Any failure ends the run with gh's message.
const planOf = (board: BoardConfig, project: ProjectRef) =>
  Effect.gen(function* () {
    const state = yield* readBoard(project)
    const removals: Removal[] = []
    yield* planned(() =>
      planBoard(board, state, (what) => {
        removals.push(what)
        return 0
      }),
    )
    const counts = removals.length > 0 ? yield* countRemovals(state, removals) : new Map<string, number>()
    const plan = yield* planned(() => planBoard(board, state, (what) => counts.get(removalKey(what)) ?? 0))
    return { state, ...plan }
  }).pipe(
    Effect.mapError((error) => {
      const message = said(error)
      const hint = /resolve to an Organization/.test(message)
        ? '\n(board.github.project.ownerType defaults to organization: a Project of a user says "user")'
        : ''
      return new BoardFailed({ message: `reading the board: ${message}${hint}` })
    }),
  )

const sync = Effect.fnUntraced(function* (mode: 'dry run' | 'apply' | 'check') {
  const { board, project } = yield* configured((data) => ({
    board: getValue(data, 'board') as BoardConfig,
    project: getValue(data, 'board.github.project') as ProjectRef & { title?: string },
  }))
  const { state, steps, manual } = yield* planOf(board, project)
  const title = project.title ? ` (${project.title})` : ''
  yield* Console.log(`lntt board sync: ${project.owner} project ${project.number}${title}, ${mode}`)
  yield* lines(steps.length ? steps.map((s) => `  ${describeStep(s)}`).join('\n') : '  nothing to change')

  if (mode !== 'apply') {
    yield* printManual(manual)
    if (mode === 'check' && (steps.length || manual.length)) {
      return yield* new BoardFailed({
        message: `the board differs from the configuration: ${steps.length} changes, ${manual.length} by hand`,
      })
    }
    if (mode === 'dry run' && steps.length) yield* Console.log('run with --apply to make these changes')
    return 0
  }

  for (const [i, step] of steps.entries()) {
    if (i > 0) yield* Effect.sleep(PAUSE_MS)
    yield* applyStep(state, step).pipe(
      Effect.catch((error) =>
        Effect.andThen(
          printManual(manual),
          Effect.fail(
            new BoardFailed({ message: `${describeStep(step)}: ${said(error)}\napplied ${i} changes before it` }),
          ),
        ),
      ),
    )
  }
  if (steps.length) yield* Console.log(`applied ${steps.length} changes`)
  // Read back: every change must show, or the run says what still differs.
  const after = yield* planOf(board, project)
  if (after.steps.length) {
    return yield* new BoardFailed({
      message:
        `still differs after --apply:\n${after.steps.map((s) => `  ${describeStep(s)}`).join('\n')}\n` +
        '(a read right after a write can lag: run it again before changing anything)',
    })
  }
  yield* printManual(after.manual)
  return 0
})

const printReady = (issues: ProjectIssue[]) =>
  Effect.gen(function* () {
    const of = (kind: ProjectIssue['verdict']['kind']) => issues.filter((issue) => issue.verdict.kind === kind)
    const head = (issue: ProjectIssue) => `#${issue.number} ${issue.title}`
    const section = (title: string, group: ProjectIssue[], line: (issue: ProjectIssue) => string) =>
      group.length > 0 ? lines(`  ${title}:\n${group.map((issue) => `    ${line(issue)}`).join('\n')}`) : Effect.void
    yield* section('Ready-eligible', of('eligible'), head)
    yield* section('not yet', of('missing'), (issue) =>
      issue.verdict.kind === 'missing' ? `${head(issue)}: missing ${issue.verdict.missing.join(', ')}` : head(issue),
    )
    yield* section('picked up through their sub-issues', of('holds'), (issue) =>
      issue.verdict.kind === 'holds' ? `${head(issue)}: ${holdsLine(issue.verdict.open)}` : head(issue),
    )
    if (issues.length === 0) yield* Console.log('  no issue at the first status')
  })

const ready = Effect.fnUntraced(function* (parsed: Extract<BoardCommand, { kind: 'ready' }>) {
  const rules: ReadyRules | null = yield* configured(readyRules)
  if (!rules) {
    return yield* new BoardFailed({
      message: 'nothing to check: it reads a GitHub board with board.github.project and board.fields.status',
    })
  }
  const gh = yield* Gh
  const repo =
    parsed.repository ??
    (yield* gh.repository.pipe(
      Effect.mapError(
        (error) =>
          new BoardFailed({
            message: `reading the repository: ${error.output || 'gh repo view failed'}\n(gh repo set-default, or GITHUB_REPOSITORY, names it)`,
          }),
      ),
    ))
  const read = readFirstStatus(rules, repo).pipe(
    Effect.mapError((error) => new BoardFailed({ message: `reading the board: ${said(error)}` })),
  )
  const { project, status } = rules
  const title = project.title ? ` (${project.title})` : ''
  const issues = yield* read
  yield* Console.log(
    `lntt board ready: ${project.owner} project ${project.number}${title}, ${repo}, ${parsed.apply ? 'apply' : 'dry run'}`,
  )
  yield* printReady(issues)
  const eligible = issues.filter((issue) => issue.verdict.kind === 'eligible')
  if (!parsed.apply) {
    if (eligible.length > 0) yield* Console.log(`run with --apply to move these to ${status.ready}`)
    return 0
  }
  for (const [i, issue] of eligible.entries()) {
    if (i > 0) yield* Effect.sleep(PAUSE_MS)
    yield* moveToReady(issue.target).pipe(
      Effect.mapError(
        (error) => new BoardFailed({ message: `#${issue.number}: ${said(error)}\nmoved ${i} before it` }),
      ),
    )
  }
  if (eligible.length > 0) {
    yield* Console.log(`moved ${eligible.length} issue${eligible.length === 1 ? '' : 's'} to ${status.ready}`)
    // Read back: every move must show, or the run says what did not.
    const after = new Set((yield* read).map((issue) => issue.number))
    const still = eligible.filter((issue) => after.has(issue.number))
    if (still.length > 0) {
      return yield* new BoardFailed({
        message:
          `still at ${status.initial} after --apply: ${still.map((issue) => `#${issue.number}`).join(', ')}\n` +
          '(a read right after a write can lag: run it again before changing anything)',
      })
    }
  }
  return 0
})

// A command's exit code: 0, 1 for a board that differs (--check) or any expected failure, said by
// its message.
export const command = (parsed: BoardCommand) =>
  (parsed.kind === 'sync' ? sync(parsed.mode) : ready(parsed)).pipe(
    Effect.catchTag('BoardFailed', (error) =>
      Effect.as(Console.error(`lntt board ${parsed.kind}: ${error.message}`), 1),
    ),
  )

// The services on the machine.
const Live = Layer.mergeAll(GhLive, ProjectConfigLive).pipe(
  Layer.provide(Layer.mergeAll(SpawnerLive, NodeFileSystem.layer, NodePath.layer)),
)

// Runs a command as the process's main program (src/run-command.ts): its exit code.
export function runBoard(parsed: BoardCommand): Promise<never> {
  return runCommand(command(parsed).pipe(Effect.map(exit), Effect.provide(Live)))
}
