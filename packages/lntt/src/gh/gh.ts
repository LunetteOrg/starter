// GitHub's CLI as a service of lntt's own (docs/adr/effect-in-lntt.md#services): what lntt's
// modules on Effect read from GitHub, each a typed Effect. The live layer runs gh through Effect's
// ChildProcessSpawner, in the current directory or the one ghAt names, so gh finds the repository
// there; Gh.memory answers from a record, for a spec. The candidate automation (src/ci/candidate.ts)
// keeps its own client until lntt ci moves.

import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { ChildProcessSpawner } from 'effect/process'
import { captured } from '../captured.ts'

// gh exited non-zero, could not start, or answered what is not JSON: the command and what it said.
export class GhError extends Data.TaggedError('GhError')<{ args: readonly string[]; output: string }> {
  get message() {
    return `gh ${this.args.slice(0, 2).join(' ')} failed${this.output ? `: ${this.output}` : ''}`
  }
}

type Run<A> = Effect.Effect<A, GhError>

// An open pull request, by its head.
export interface PullRequestHead {
  number: number
  headRefName: string
}

// An issue as the REST API gives it, with what lntt reads of it.
export interface Issue {
  title: string
  labels: { name: string }[]
  type?: { name: string } | null
}

export interface GhOperations {
  // owner/name of the repository gh works on.
  readonly repository: Run<string>
  // The open pull requests of `repo` into `base` that GitHub finds with `search`.
  readonly openPullRequests: (query: { repo: string; base: string; search: string }) => Run<PullRequestHead[]>
  // Issue `number` of the repository gh works on.
  readonly issue: (number: number) => Run<Issue>
}

export class Gh extends Context.Service<Gh, GhOperations>()('@lntt/lntt/gh/Gh') {
  // GitHub in memory: each operation answers from `answers`, and one not given fails as gh would
  // without a connection.
  static memory(answers: Partial<GhOperations>) {
    const missing = (name: string) => Effect.fail(new GhError({ args: [name], output: 'not answered' }))
    return Layer.succeed(Gh)(
      Gh.of({
        repository: missing('repository'),
        openPullRequests: () => missing('openPullRequests'),
        issue: () => missing('issue'),
        ...answers,
      }),
    )
  }
}

// gh on the machine, in `dir`, else in the current directory.
export const ghAt = (dir?: string) =>
  Layer.effect(Gh)(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      // Its stdout; gh's own refusal text (a token without a permission) is in the error.
      const run = (...args: string[]) =>
        captured(spawner, 'gh', args, dir).pipe(
          Effect.mapError((error) => new GhError({ args, output: error.message })),
          Effect.flatMap(({ out, err, code }) =>
            code === 0 ? Effect.succeed(out) : Effect.fail(new GhError({ args, output: err })),
          ),
        )
      const json = <A>(...args: string[]) =>
        Effect.flatMap(run(...args), (out) =>
          Effect.try({
            try: () => JSON.parse(out) as A,
            catch: () => new GhError({ args, output: `not JSON: ${out.slice(0, 80)}` }),
          }),
        )
      return Gh.of({
        repository: run('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'),
        openPullRequests: ({ repo, base, search }) =>
          json<PullRequestHead[]>(
            'pr',
            'list',
            '--repo',
            repo,
            '--state',
            'open',
            '--base',
            base,
            '--search',
            search,
            '--json',
            'number,headRefName',
          ),
        issue: (number) => json<Issue>('api', `repos/{owner}/{repo}/issues/${number}`),
      })
    }),
  )

// gh on the machine, in the current directory.
export const GhLive = ghAt()
