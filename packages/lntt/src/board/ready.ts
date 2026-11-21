// What `lntt board ready` reads from GitHub and writes to it, each an Effect over the Gh service:
// the issues at the board's first status, page by page, and the move of one to the ready status.
// The queries and how an answer reads are plain logic (src/board-ready.ts).

import * as Effect from 'effect/Effect'
import {
  firstStatusPage,
  firstStatusQuery,
  MOVE_TO_READY,
  type ProjectIssue,
  type ReadyRules,
  type ReadyTarget,
} from '../board-ready.ts'
import { Gh } from '../gh/gh.ts'
import { planned } from './github.ts'

// Every open issue of `repo` at the first status of the configured Project. A Project without
// the status the configuration names is a BoardFailed.
export const readFirstStatus = Effect.fnUntraced(function* (rules: ReadyRules, repo: string) {
  const gh = yield* Gh
  const query = firstStatusQuery(rules)
  const found: ProjectIssue[] = []
  let after: string | null = null
  do {
    const answer = yield* gh.graphql(query, { owner: rules.project.owner, number: rules.project.number, after })
    const page: ReturnType<typeof firstStatusPage> = yield* planned(() => firstStatusPage(rules, answer, repo))
    found.push(...page.found)
    after = page.after
  } while (after !== null)
  return found
})

export const moveToReady = (target: ReadyTarget) =>
  Effect.asVoid(Effect.flatMap(Gh, (gh) => gh.graphql(MOVE_TO_READY, { ...target })))
