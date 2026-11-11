// The bridge of lntt review's commands on Effect to the sync code of modules not yet moved
// (docs/adr/effect-in-lntt.md#the-bridge-while-modules-move): the project's configuration, the
// place of the state store, the base, lntt check's areas and the files the reviewers cite, the
// agents' CLIs, the limit's message to the parent, Orca's subagents. The live layer runs that
// code under Effect.try, and what it throws is a ReviewFailed; a spec gives its own answers.
// Each piece leaves the bridge when its module moves to Effect.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from 'node:process'
import * as Console from 'effect/Console'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import type { BranchRules } from '../branch.ts'
import { type Area, type Cited, cite, formatJson, runArea } from '../check.ts'
import type { HeadlessAgent as Agent } from '../headless.ts'
import type { Started } from '../messages.ts'
import { orcaSubagents, type Subagents } from '../orca-subagents.ts'
import { type Asked, agentProblems, askAtLimit, baseRef, loaded, placeFor, reportsTo } from './host.ts'

// What the sync code threw: an expected failure, reported by its message.
export class ReviewFailed extends Data.TaggedError('ReviewFailed')<{ cause: unknown }> {
  get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

type Failing<A> = Effect.Effect<A, ReviewFailed>

export interface Bridged {
  // The project's configuration: the defaults with no file, a ReviewFailed when it does not validate.
  readonly config: Failing<Record<string, unknown>>
  // The directory of the state store, from the clone's common and own git directories.
  readonly place: (common: string, gitDir: string, data: Record<string, unknown>) => Failing<string>
  // The ref a round compares the branch with, --base or the project's base, and the line that names it.
  readonly base: (root: string, given: string | undefined) => Failing<{ ref: string; said: string | null }>
  // What keeps each agent from starting, as a line each.
  readonly agentProblems: (agents: Agent[]) => Failing<string[]>
  // The results of lntt check's areas a lens is named after, as their JSON.
  readonly checks: (
    areas: Area[],
    options: { root: string; data: Record<string, unknown>; base: string },
  ) => Failing<Record<string, string>>
  // The working tree as runRound (still on Promises) reads it: a brief, and a cited line.
  readonly files: (root: string) => {
    readBrief: (path: string) => string
    cite: (path: string, line: number | null) => Cited
  }
  // Who the branch reports to, and the limit sent there.
  readonly reportsTo: (branch: string, rules: BranchRules) => Effect.Effect<Started | null>
  readonly askAtLimit: (
    marker: Started,
    branch: string,
    text: string,
  ) => Effect.Effect<{ asked: Asked | null; line: string }>
  // Orca's subagents of the Claude Code session, when lntt review runs under one.
  readonly orca: (root: string) => Effect.Effect<Subagents | null>
}

export class ReviewBridge extends Context.Service<ReviewBridge, Bridged>()('@lntt/lntt/review/bridge/ReviewBridge') {}

const bridged = <A>(run: () => A) => Effect.try({ try: run, catch: (cause) => new ReviewFailed({ cause }) })

export const ReviewBridgeLive = Layer.effect(ReviewBridge)(
  Effect.gen(function* () {
    // Read once per command, as the sync code did.
    const config = yield* Effect.cached(bridged(loaded))
    return ReviewBridge.of({
      config,
      place: (common, gitDir, data) =>
        Effect.gen(function* () {
          const said: string[] = []
          const placed = yield* bridged(() => placeFor(common, gitDir, data, (line) => said.push(line)))
          for (const line of said) yield* Console.error(`lntt review: ${line}`)
          return placed.dir
        }),
      base: (root, given) => bridged(() => baseRef(root, given)),
      agentProblems: (agents) => bridged(() => agentProblems(agents)),
      checks: (areas, { root, data, base }) =>
        bridged(() =>
          // A round runs no test: touched places the lines from the imports, never by coverage.
          Object.fromEntries(
            areas.map((area) => [
              area,
              formatJson(runArea(area, undefined, [], { root, data, base, coverage: false })),
            ]),
          ),
        ),
      files: (root) => ({
        readBrief: (path) => readFileSync(join(root, path), 'utf8'),
        cite: (path, line) => cite(root, path, line),
      }),
      reportsTo: (branch, rules) => Effect.sync(() => reportsTo(branch, rules)),
      askAtLimit: (marker, branch, text) => Effect.sync(() => askAtLimit(marker, branch, text)),
      orca: (root) => Effect.sync(() => orcaSubagents(env, root)),
    })
  }),
)
