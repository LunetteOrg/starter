// The bridge of lntt review's commands on Effect to the sync code of modules not yet moved
// (docs/adr/effect-in-lntt.md#the-bridge-while-modules-move): lntt check's areas, the last piece,
// which leaves with lntt check's move to Effect (#337), and the bridge with it. The live layer runs
// that code under Effect.try, and what it throws is a ReviewFailed; a spec gives its own answers.

import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { type Area, formatJson, runArea } from '../check.ts'

// What the sync code threw: an expected failure, reported by its message.
export class ReviewFailed extends Data.TaggedError('ReviewFailed')<{ cause: unknown }> {
  get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

type Failing<A> = Effect.Effect<A, ReviewFailed>

export interface Bridged {
  // The results of lntt check's areas a lens is named after, as their JSON.
  readonly checks: (
    areas: Area[],
    options: { root: string; data: Record<string, unknown>; base: string },
  ) => Failing<Record<string, string>>
}

export class ReviewBridge extends Context.Service<ReviewBridge, Bridged>()('@lntt/lntt/review/bridge/ReviewBridge') {}

const bridged = <A>(run: () => A) => Effect.try({ try: run, catch: (cause) => new ReviewFailed({ cause }) })

export const ReviewBridgeLive = Layer.effect(ReviewBridge)(
  Effect.sync(() =>
    ReviewBridge.of({
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
    }),
  ),
)
