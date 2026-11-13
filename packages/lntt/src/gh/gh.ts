// GitHub's CLI as a service of lntt's own (docs/adr/effect-in-lntt.md#services): what lntt's
// modules on Effect read from GitHub, each a typed Effect. The live layer runs gh through Effect's
// ChildProcessSpawner, in the current directory or the one ghAt names, so gh finds the repository
// there; Gh.memory answers from a record, for a spec. The live layer takes a token (the candidate
// automation's Projects token, a second layer of Gh) and a dry run, which prints a write's command
// instead of running it; Gh.over runs the same operations over any runner, for a spec that answers
// gh's arguments.

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

export interface GhOperations extends CandidateGhOperations {
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
}

export class Gh extends Context.Service<Gh, GhOperations>()('@lntt/lntt/gh/Gh') {
  // GitHub in memory: each operation answers from `answers`, and one not given fails as gh would
  // without a connection.
  static memory(answers: Partial<GhOperations>) {
    const missing = (name: string) => Effect.fail(new GhError({ args: [name], output: 'not answered' }))
    const fn = (name: string) => () => missing(name)
    return Layer.succeed(Gh)(
      Gh.of({
        ...(Object.fromEntries(
          CANDIDATE_OPERATIONS.map((name) => [name, fn(name)]),
        ) as unknown as CandidateGhOperations),
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
        ...answers,
      } as GhOperations),
    )
  }

  // gh's operations over `runner`, which answers gh's arguments (`write` for a call that changes
  // GitHub): a spec's record of answers, or another process.
  static over(runner: GhRunner) {
    return Layer.succeed(Gh)(Gh.of(operations(runner)))
  }
}

// Runs gh with these arguments, `input` on its stdin: its stdout. `write` marks a call that changes
// GitHub, which a dry run prints instead of making.
export type GhRunner = (args: string[], options?: { input?: string; write?: boolean }) => Run<string>

// gh on the machine, in `dir`, else in the current directory; with `token` as GH_TOKEN; in a dry run,
// a write is printed through `dryRun` (`[dry-run] gh <args>`, then its stdin) and answers nothing.
export const ghAt = (dir?: string, options: { token?: string; dryRun?: (line: string) => void } = {}) =>
  Layer.effect(Gh)(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const env = options.token ? { GH_TOKEN: options.token } : undefined
      // Its stdout, `input` on its stdin; gh's own refusal text (a token without a permission) is in
      // the error.
      const runner: GhRunner = (args, { input, write } = {}) => {
        if (write && options.dryRun) {
          const print = options.dryRun
          return Effect.sync(() => {
            print(`[dry-run] gh ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`)
            if (input !== undefined) print(`[dry-run] stdin:\n${input}`)
            return ''
          })
        }
        return captured(spawner, 'gh', args, dir, input, env).pipe(
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
      }
      return Gh.of(operations(runner))
    }),
  )

// Every operation, over a runner.
function operations(runner: GhRunner): GhOperations {
  const runWith = (input: string | undefined, args: string[]) => runner(args, input === undefined ? {} : { input })
  const writeWith = (input: string | undefined, args: string[]) =>
    runner(args, { write: true, ...(input === undefined ? {} : { input }) })
  const run = (...args: string[]) => runWith(undefined, args)
  const parse = <A>(args: string[], out: string) =>
    Effect.try({
      try: () => JSON.parse(out) as A,
      catch: () => new GhError({ args, output: `not JSON: ${out.slice(0, 80)}` }),
    })
  const json = <A>(...args: string[]) => Effect.flatMap(run(...args), (out) => parse<A>(args, out))
  return {
    ...candidateOperations(runner),
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
        Effect.flatMap((out) => parse<{ data?: Record<string, unknown>; errors?: { message: string }[] }>(args, out)),
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
      writeWith(body, ['issue', 'create', '--repo', repo, '--title', title, '--body-file', '-']),
    commentIssue: ({ repo, number, body }) =>
      writeWith(body, ['issue', 'comment', String(number), '--repo', repo, '--body-file', '-']),
    commentPullRequest: ({ repo, number, body }) =>
      writeWith(body, ['pr', 'comment', String(number), '--repo', repo, '--body-file', '-']),
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
        writeWith(JSON.stringify({ body }), [
          'api',
          '-X',
          'PATCH',
          `repos/${repo}/issues/comments/${id}`,
          '--input',
          '-',
        ]),
      ),
  }
}

// gh on the machine, in the current directory.
export const GhLive = ghAt()

// --- The candidate automation (src/ci/candidate.ts) and lntt ci proved (src/ci/proved.ts) -------
//
// What they read from GitHub and write to it, each with the arguments gh is run with: a dry run
// prints them, and a spec answers them.

// An open candidate's pull request, as the automation reads it.
export interface CandidatePullRequest {
  number: number
  headRefName: string
  headRefOid?: string
  body?: string
}

// A pull request merged into a branch, with the fields asked for.
export interface MergedPullRequest {
  number: number
  title?: string
  body: string | null
  mergedAt?: string
}

// A pull request as `gh pr view` gives it.
export interface PullRequestView {
  number: number
  title: string
  body: string | null
  baseRefName: string
  headRefName: string
  labels: Array<{ name: string }>
  mergedAt: string | null
  author?: { login: string } | null
  isCrossRepository?: boolean
}

// A workflow run, and the jobs of one, as the REST API gives them.
export interface WorkflowRun {
  id: number
  event: string
  status: string
  conclusion: string | null
  html_url?: string
}

export interface RunJob {
  name: string
  conclusion: string | null
  steps?: Array<{ name: string; conclusion: string | null }>
}

export interface CandidateGhOperations {
  // The open pull requests of `repo` into `base` from a branch under `prefix`.
  readonly candidatePullRequests: (query: { repo: string; base: string; prefix: string }) => Run<CandidatePullRequest[]>
  // The branches under `prefix`, and the heads of every pull request from one (any state).
  readonly branchesUnder: (query: { repo: string; prefix: string }) => Run<string[]>
  readonly pullRequestHeads: (query: { repo: string; prefix: string }) => Run<string[]>
  // A commit and its tree.
  readonly commitOf: (query: { repo: string; ref: string }) => Run<{ sha: string; tree: string }>
  // Every node a paginated GraphQL query gives through `jq`, the variables as -f fields.
  readonly graphqlNodes: (query: string, fields: Record<string, string>, jq: string) => Run<unknown[]>
  // A GraphQL request with its variables as -f (strings) and -F (numbers) fields: its data. The
  // write is the same request, which a dry run prints.
  readonly graphqlFields: (query: string, variables: Record<string, unknown>) => Run<Record<string, unknown>>
  readonly graphqlWrite: (query: string, variables: Record<string, unknown>) => Run<Record<string, unknown>>
  // An issue's state, and whether it is a pull request.
  readonly issueState: (query: { repo: string; number: number }) => Run<{ state: string; isPr: boolean }>
  // The bodies of an issue's comments, in order.
  readonly issueCommentBodies: (query: { repo: string; number: number }) => Run<string[]>
  // The open pull requests from `head` into `base`.
  readonly pullRequestsFrom: (query: {
    repo: string
    head: string
    base: string
  }) => Run<Array<{ number: number; body: string }>>
  // The pull requests merged into `base`, at most 500, with the `fields` gh's --json names.
  readonly mergedInto: (query: { repo: string; base: string; fields: string }) => Run<MergedPullRequest[]>
  // How far `head` is behind `base`, and their merge base.
  readonly behind: (query: { repo: string; base: string; head: string }) => Run<{ behindBy: number; base: string }>
  readonly pullRequestView: (query: { repo: string; number: number }) => Run<PullRequestView>
  // Writes: an empty commit, a branch at it, a draft pull request (its URL), a new base or body, a
  // closed issue.
  readonly createCommit: (commit: { repo: string; message: string; tree: string; parent: string }) => Run<string>
  readonly createBranch: (branch: { repo: string; name: string; sha: string }) => Run<void>
  readonly createDraft: (pr: { repo: string; base: string; head: string; title: string; body: string }) => Run<string>
  readonly retarget: (pr: { repo: string; number: number; base: string }) => Run<void>
  readonly editBody: (pr: { repo: string; number: number; body: string }) => Run<void>
  readonly closeIssue: (issue: { repo: string; number: number }) => Run<void>
  // lntt ci proved: the pull requests of a commit, its tree, how two commits compare, the runs of
  // a workflow on a commit, the jobs of a run.
  readonly commitPullRequests: (query: {
    repo: string
    sha: string
  }) => Run<Array<{ number: number; merged_at: string | null; base: { ref: string }; head: { sha: string } }>>
  readonly treeOf: (query: { repo: string; sha: string }) => Run<unknown>
  readonly compareStatus: (query: { repo: string; base: string; head: string }) => Run<string>
  readonly workflowRuns: (query: { repo: string; workflow: string; sha: string }) => Run<WorkflowRun[]>
  readonly runJobs: (query: { repo: string; run: number }) => Run<RunJob[]>
}

export const CANDIDATE_OPERATIONS = [
  'candidatePullRequests',
  'branchesUnder',
  'pullRequestHeads',
  'commitOf',
  'graphqlNodes',
  'graphqlFields',
  'graphqlWrite',
  'issueState',
  'issueCommentBodies',
  'pullRequestsFrom',
  'mergedInto',
  'behind',
  'pullRequestView',
  'createCommit',
  'createBranch',
  'createDraft',
  'retarget',
  'editBody',
  'closeIssue',
  'commitPullRequests',
  'treeOf',
  'compareStatus',
  'workflowRuns',
  'runJobs',
] as const satisfies ReadonlyArray<keyof CandidateGhOperations>

// The -f (string) and -F (number) fields of a GraphQL request: an Int! sent as a string is refused.
const fieldsOf = (variables: Record<string, unknown>) =>
  Object.entries(variables).flatMap(([key, value]) => [typeof value === 'number' ? '-F' : '-f', `${key}=${value}`])

function candidateOperations(runner: GhRunner): CandidateGhOperations {
  const parse = <A>(args: string[], out: string) =>
    Effect.try({
      try: () => JSON.parse(out) as A,
      catch: () => new GhError({ args, output: `not JSON: ${out.slice(0, 80)}` }),
    })
  const json = <A>(args: string[]) => Effect.flatMap(runner(args), (out) => parse<A>(args, out))
  // Lines of JSON, one per page.
  const lines = <A>(args: string[]) =>
    Effect.flatMap(runner(args), (out) =>
      Effect.forEach(
        out.split('\n').filter((line) => line.trim() !== ''),
        (line) => parse<A>(args, line),
      ),
    )
  const write = (args: string[], input?: string) =>
    runner(args, { write: true, ...(input === undefined ? {} : { input }) })
  const data = (args: string[]) => (out: string) =>
    out === ''
      ? Effect.succeed({} as Record<string, unknown>)
      : Effect.map(parse<{ data?: Record<string, unknown> }>(args, out), (body) => body.data ?? {})
  return {
    candidatePullRequests: ({ repo, base, prefix }) =>
      json([
        'pr',
        'list',
        '--repo',
        repo,
        '--state',
        'open',
        '--base',
        base,
        '--search',
        `head:${prefix}`,
        '--json',
        'number,headRefName,headRefOid,body',
      ]),
    branchesUnder: ({ repo, prefix }) =>
      Effect.map(json<Array<{ ref: string }>>(['api', `repos/${repo}/git/matching-refs/heads/${prefix}`]), (refs) =>
        refs.map((ref) => ref.ref.replace(/^refs\/heads\//, '')),
      ),
    pullRequestHeads: ({ repo, prefix }) =>
      Effect.map(
        json<Array<{ headRefName: string }>>([
          'pr',
          'list',
          '--repo',
          repo,
          '--state',
          'all',
          '--search',
          `head:${prefix}`,
          '--limit',
          '100',
          '--json',
          'headRefName',
        ]),
        (prs) => prs.map((pr) => pr.headRefName),
      ),
    commitOf: ({ repo, ref }) =>
      Effect.map(
        json<{ sha: string; commit: { tree: { sha: string } } }>(['api', `repos/${repo}/commits/${ref}`]),
        (c) => ({
          sha: c.sha,
          tree: c.commit.tree.sha,
        }),
      ),
    graphqlNodes: (query, fields, jq) =>
      Effect.map(
        lines<unknown[]>([
          'api',
          'graphql',
          '--paginate',
          '-f',
          `query=${query}`,
          ...Object.entries(fields).flatMap(([key, value]) => ['-f', `${key}=${value}`]),
          '--jq',
          jq,
        ]),
        (pages) => pages.flat(),
      ),
    graphqlFields: (query, variables) => {
      const args = ['api', 'graphql', '-f', `query=${query}`, ...fieldsOf(variables)]
      return Effect.flatMap(runner(args), data(args))
    },
    graphqlWrite: (query, variables) => {
      const args = ['api', 'graphql', '-f', `query=${query}`, ...fieldsOf(variables)]
      return Effect.flatMap(write(args), data(args))
    },
    issueState: ({ repo, number }) =>
      json(['api', `repos/${repo}/issues/${number}`, '--jq', '{state: .state, isPr: (.pull_request != null)}']),
    issueCommentBodies: ({ repo, number }) =>
      Effect.map(
        lines<string[]>(['api', '--paginate', `repos/${repo}/issues/${number}/comments`, '--jq', '[.[].body]']),
        (pages) => pages.flat(),
      ),
    pullRequestsFrom: ({ repo, head, base }) =>
      json(['pr', 'list', '--repo', repo, '--state', 'open', '--head', head, '--base', base, '--json', 'number,body']),
    mergedInto: ({ repo, base, fields }) =>
      json(['pr', 'list', '--repo', repo, '--state', 'merged', '--base', base, '--limit', '500', '--json', fields]),
    behind: ({ repo, base, head }) =>
      json([
        'api',
        `repos/${repo}/compare/${base}...${head}`,
        '--jq',
        '{behindBy: .behind_by, base: .base_commit.sha}',
      ]),
    pullRequestView: ({ repo, number }) =>
      json([
        'pr',
        'view',
        String(number),
        '--repo',
        repo,
        '--json',
        'number,title,body,baseRefName,headRefName,labels,mergedAt,author,isCrossRepository',
      ]),
    createCommit: ({ repo, message, tree, parent }) =>
      write([
        'api',
        `repos/${repo}/git/commits`,
        '-f',
        `message=${message}`,
        '-f',
        `tree=${tree}`,
        '-f',
        `parents[]=${parent}`,
        '--jq',
        '.sha',
      ]),
    createBranch: ({ repo, name, sha }) =>
      Effect.asVoid(write(['api', `repos/${repo}/git/refs`, '-f', `ref=refs/heads/${name}`, '-f', `sha=${sha}`])),
    createDraft: ({ repo, base, head, title, body }) =>
      write(
        [
          'pr',
          'create',
          '--repo',
          repo,
          '--draft',
          '--base',
          base,
          '--head',
          head,
          '--title',
          title,
          '--body-file',
          '-',
        ],
        body,
      ),
    retarget: ({ repo, number, base }) =>
      Effect.asVoid(write(['pr', 'edit', String(number), '--repo', repo, '--base', base])),
    editBody: ({ repo, number, body }) =>
      Effect.asVoid(write(['pr', 'edit', String(number), '--repo', repo, '--body-file', '-'], body)),
    closeIssue: ({ repo, number }) =>
      Effect.asVoid(write(['issue', 'close', String(number), '--repo', repo, '--reason', 'completed'])),
    commitPullRequests: ({ repo, sha }) => json(['api', `repos/${repo}/commits/${sha}/pulls`]),
    treeOf: ({ repo, sha }) =>
      Effect.map(
        json<{ tree?: { sha?: unknown } | null }>(['api', `repos/${repo}/git/commits/${sha}`]),
        (c) => c.tree?.sha,
      ),
    compareStatus: ({ repo, base, head }) =>
      Effect.map(json<{ status: string }>(['api', `repos/${repo}/compare/${base}...${head}`]), (c) => c.status),
    workflowRuns: ({ repo, workflow, sha }) =>
      Effect.map(
        json<{ workflow_runs: WorkflowRun[] }>([
          'api',
          `repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=100`,
        ]),
        (page) => page.workflow_runs,
      ),
    runJobs: ({ repo, run }) =>
      Effect.map(
        json<{ jobs: RunJob[] }>(['api', `repos/${repo}/actions/runs/${run}/jobs?per_page=100`]),
        (page) => page.jobs,
      ),
  }
}
