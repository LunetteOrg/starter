// The bridge of lntt review's commands on Effect to the sync code of modules not yet moved
// (docs/adr/effect-in-lntt.md#the-bridge-while-modules-move): the base, lntt check's areas, the limit's message to the parent,
// Orca's subagents. The live layer runs that
// code under Effect.try, and what it throws is a ReviewFailed; a spec gives its own answers.
// Each piece leaves the bridge when its module moves to Effect.

import { env } from 'node:process'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import type { BranchRules } from '../branch.ts'
import { type Area, formatJson, runArea } from '../check.ts'
import type { Started } from '../messages.ts'
import { orcaSubagents, type Subagents } from '../orca-subagents.ts'
import { type Asked, askAtLimit, baseRef, reportsTo } from './host.ts'

// What the sync code threw: an expected failure, reported by its message.
export class ReviewFailed extends Data.TaggedError('ReviewFailed')<{ cause: unknown }> {
  get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

type Failing<A> = Effect.Effect<A, ReviewFailed>

export interface Bridged {
  // The ref a round compares the branch with, --base or the project's base, and the line that names it.
  readonly base: (root: string, given: string | undefined) => Failing<{ ref: string; said: string | null }>
  // The results of lntt check's areas a lens is named after, as their JSON.
  readonly checks: (
    areas: Area[],
    options: { root: string; data: Record<string, unknown>; base: string },
  ) => Failing<Record<string, string>>
  // Who the branch reports to, and the limit sent there.
  readonly reportsTo: (branch: string, rules: BranchRules) => Failing<Started | null>
  readonly askAtLimit: (marker: Started, branch: string, text: string) => Failing<{ asked: Asked | null; line: string }>
  // Orca's subagents of the Claude Code session, when lntt review runs under one.
  readonly orca: (root: string) => Failing<Subagents | null>
}

export class ReviewBridge extends Context.Service<ReviewBridge, Bridged>()('@lntt/lntt/review/bridge/ReviewBridge') {}

const bridged = <A>(run: () => A) => Effect.try({ try: run, catch: (cause) => new ReviewFailed({ cause }) })

export const ReviewBridgeLive = Layer.effect(ReviewBridge)(
  Effect.sync(() =>
    ReviewBridge.of({
      base: (root, given) => bridged(() => baseRef(root, given)),
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
      reportsTo: (branch, rules) => bridged(() => reportsTo(branch, rules)),
      askAtLimit: (marker, branch, text) => bridged(() => askAtLimit(marker, branch, text)),
      orca: (root) => bridged(() => orcaSubagents(env, root)),
    }),
  ),
)
