// GitHub's CLI as a service of lntt's own (docs/adr/effect-in-lntt.md#services): what lntt's
// modules on Effect read from GitHub, each a typed Effect. The live layer runs gh through Effect's
// ChildProcessSpawner, in the current directory or the one ghAt names, so gh finds the repository
// there; Gh.memory answers from a record, for a spec. The candidate automation (src/ci/candidate.ts)
// keeps its own client until lntt ci moves (#340).

import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { ChildProcessSpawner } from 'effect/process'
import { captured } from '../captured.ts'

// gh exited non-zero, could not start, or answered what is not JSON (or a GraphQL answer with
// errors): the command and what it said. `missing`: gh is not installed, so nothing could be asked.
export class GhError extends Data.TaggedError('GhError')<{
  args: readonly string[]
  output: string
  missing?: boolean
}> {
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

// An issue a search found.
export interface IssueHit {
  number: number
  title: string
  url: string
}

// A comment of an issue or a pull request.
export interface Comment {
  id: number
  body: string
}

// A pull request's body and head, as lntt check reads them.
export interface PullRequestBody {
  number: number
  body: string | null
  headRefName: string
}

export interface GhOperations {
  // owner/name of the repository gh works on.
  readonly repository: Run<string>
  // The open pull requests of `repo` into `base` that GitHub finds with `search`.
  readonly openPullRequests: (query: { repo: string; base: string; search: string }) => Run<PullRequestHead[]>
  // Issue `number` of the repository gh works on.
  readonly issue: (number: number) => Run<Issue>
  // An issue or pull request of `repo` by its number: its title and URL as gh prints them, not
  // yet made safe to show.
  readonly issueLink: (query: { repo: string; number: number }) => Run<{ title: string; url: string }>
  // One request to GitHub's GraphQL API: its data; an answer with errors is a GhError of their
  // messages.
  readonly graphql: (query: string, variables: Record<string, unknown>) => Run<Record<string, unknown>>
  // The open issues of `repo` GitHub finds with `words`, at most 20.
  readonly searchIssues: (query: { repo: string; words: string }) => Run<IssueHit[]>
  // Opens an issue, comments an issue or a pull request: the URL gh prints.
  readonly createIssue: (issue: { repo: string; title: string; body: string }) => Run<string>
  readonly commentIssue: (comment: { repo: string; number: number; body: string }) => Run<string>
  readonly commentPullRequest: (comment: { repo: string; number: number; body: string }) => Run<string>
  // Every comment of issue or pull request `number`, in order, read page by page.
  readonly issueComments: (query: { repo: string; number: number }) => Run<Comment[]>
  // Replaces the body of comment `id`.
  readonly updateComment: (comment: { repo: string; id: number; body: string }) => Run<void>

  // What lntt check's body area reads: pull request `number` of the repository gh works on, the
  // current branch's when none is given.
  readonly pullRequest: (number?: number) => Run<PullRequestBody>
}

export class Gh extends Context.Service<Gh, GhOperations>()('@lntt/lntt/gh/Gh') {
  // GitHub in memory: each operation answers from `answers`, and one not given fails as gh would
  // without a connection.
  static memory(answers: Partial<GhOperations>) {
    const missing = (name: string) => Effect.fail(new GhError({ args: [name], output: 'not answered' }))
    const fn = (name: string) => () => missing(name)
    return Layer.succeed(Gh)(
      Gh.of({
        repository: missing('repository'),
        openPullRequests: fn('openPullRequests'),
        issue: fn('issue'),
        issueLink: fn('issueLink'),
        graphql: fn('graphql'),
        searchIssues: fn('searchIssues'),
        createIssue: fn('createIssue'),
        commentIssue: fn('commentIssue'),
        commentPullRequest: fn('commentPullRequest'),
        issueComments: fn('issueComments'),
        updateComment: fn('updateComment'),
        pullRequest: fn('pullRequest'),
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
      // Its stdout, `input` on its stdin; gh's own refusal text (a token without a permission) is
      // in the error.
      const runWith = (input: string | undefined, args: string[]) =>
        captured(spawner, 'gh', args, dir, input).pipe(
          Effect.mapError(
            (error) =>
              new GhError({
                args,
                output: error.message,
                missing: error.reason._tag === 'NotFound',
              }),
          ),
          Effect.flatMap(({ out, err, code }) =>
            // A failure with nothing on stderr says it on stdout (an error body of gh api).
            code === 0 ? Effect.succeed(out) : Effect.fail(new GhError({ args, output: err || out })),
          ),
        )
      const run = (...args: string[]) => runWith(undefined, args)
      const parse = <A>(args: string[], out: string) =>
        Effect.try({
          try: () => JSON.parse(out) as A,
          catch: () => new GhError({ args, output: `not JSON: ${out.slice(0, 80)}` }),
        })
      const json = <A>(...args: string[]) => Effect.flatMap(run(...args), (out) => parse<A>(args, out))
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
        issueLink: ({ repo, number }) =>
          Effect.map(run('api', `repos/${repo}/issues/${number}`, '--jq', '[.title, .html_url] | @tsv'), (out) => {
            const [title = '', url = ''] = out.trim().split('\t')
            return { title, url }
          }),
        graphql: (query, variables) => {
          const args = ['api', 'graphql', '--input', '-']
          return runWith(JSON.stringify({ query, variables }), args).pipe(
            Effect.flatMap((out) =>
              parse<{ data?: Record<string, unknown>; errors?: { message: string }[] }>(args, out),
            ),
            Effect.flatMap((body) =>
              body.errors?.length
                ? Effect.fail(new GhError({ args, output: body.errors.map((e) => e.message).join('; ') }))
                : Effect.succeed(body.data ?? {}),
            ),
          )
        },
        searchIssues: ({ repo, words }) =>
          Effect.flatMap(
            run(
              'issue',
              'list',
              '--repo',
              repo,
              '--state',
              'open',
              '--search',
              words,
              '--json',
              'number,title,url',
              '--limit',
              '20',
            ),
            (out) => (out === '' ? Effect.succeed([]) : parse<IssueHit[]>(['issue', 'list'], out)),
          ),
        createIssue: ({ repo, title, body }) =>
          runWith(body, ['issue', 'create', '--repo', repo, '--title', title, '--body-file', '-']),
        commentIssue: ({ repo, number, body }) =>
          runWith(body, ['issue', 'comment', String(number), '--repo', repo, '--body-file', '-']),
        commentPullRequest: ({ repo, number, body }) =>
          runWith(body, ['pr', 'comment', String(number), '--repo', repo, '--body-file', '-']),
        issueComments: ({ repo, number }) => {
          const args = ['api', '--paginate', `repos/${repo}/issues/${number}/comments`, '--jq', '.[] | {id, body}']
          return Effect.flatMap(run(...args), (out) =>
            Effect.forEach(
              out.split('\n').filter((line) => line.trim() !== ''),
              (line) => parse<Comment>(args, line),
            ),
          )
        },
        updateComment: ({ repo, id, body }) =>
          Effect.asVoid(
            runWith(JSON.stringify({ body }), [
              'api',
              '-X',
              'PATCH',
              `repos/${repo}/issues/comments/${id}`,
              '--input',
              '-',
            ]),
          ),
        pullRequest: (number) =>
          json<PullRequestBody>(
            'pr',
            'view',
            ...(number === undefined ? [] : [String(number)]),
            '--json',
            'number,body,headRefName',
          ),
      })
    }),
  )

// gh on the machine, in the current directory.
export const GhLive = ghAt()
