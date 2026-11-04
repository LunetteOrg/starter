// `lntt board sync [--apply | --check]`: the Project and the issue types brought to the
// board section (src/board.ts; usage: bin/lntt.ts). A dry run unless --apply; --check
// exits 1 when the board differs, for a hook or a scheduled job.
//
// `lntt board ready [--apply]`: the issues at the first status, Ready-eligible or with
// what is missing (src/board-ready.ts). A dry run unless --apply, which moves the
// eligible ones and reads the board back.

import { spawnSync } from 'node:child_process'
import { cwd, env, exit, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import {
  applyStep,
  counter,
  describeStep,
  ghGraphql,
  type Manual,
  PAUSE_MS,
  pause,
  planBoard,
  readBoard,
} from './board.ts'
import {
  holdsLine,
  moveToReady,
  type ProjectIssue,
  type ReadyRules,
  readFirstStatus,
  readyRules,
} from './board-ready.ts'
import { ConfigError, getValue, loadConfig } from './index.ts'

const USAGE = 'usage: lntt board sync [--apply | --check]\n       lntt board ready [--apply]'

function usage(message?: string): never {
  if (message) stderr.write(`lntt board: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

function fail(message: string, command = 'sync'): never {
  stderr.write(`lntt board ${command}: ${message}\n`)
  exit(1)
}

function printManual(manual: Manual[]): void {
  if (manual.length === 0) return
  const entry = (m: Manual) =>
    `  ${m.what}: ${m.why}\n${m.url ? `    ${m.url}\n` : ''}${m.steps.map((s, i) => `    ${i + 1}. ${s}\n`).join('')}`
  stdout.write(`by hand, in GitHub's UI:\n${manual.map(entry).join('')}`)
}

function currentRepo(): string {
  if (env.GITHUB_REPOSITORY) return env.GITHUB_REPOSITORY
  const run = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
    encoding: 'utf8',
  })
  if (run.status !== 0) throw new Error((run.stderr || 'gh repo view failed').trim())
  return run.stdout.trim()
}

function printReady(issues: ProjectIssue[]): void {
  const of = (kind: ProjectIssue['verdict']['kind']) => issues.filter((issue) => issue.verdict.kind === kind)
  const section = (title: string, group: ProjectIssue[], line: (issue: ProjectIssue) => string) => {
    if (group.length > 0) stdout.write(`  ${title}:\n${group.map((issue) => `    ${line(issue)}\n`).join('')}`)
  }
  const head = (issue: ProjectIssue) => `#${issue.number} ${issue.title}`
  section('Ready-eligible', of('eligible'), head)
  section('not yet', of('missing'), (issue) =>
    issue.verdict.kind === 'missing' ? `${head(issue)}: missing ${issue.verdict.missing.join(', ')}` : head(issue),
  )
  section('picked up through their sub-issues', of('holds'), (issue) =>
    issue.verdict.kind === 'holds' ? `${head(issue)}: ${holdsLine(issue.verdict.open)}` : head(issue),
  )
  if (issues.length === 0) stdout.write('  no issue at the first status\n')
}

function ready(args: string[]): void {
  let apply = false
  try {
    const { values, positionals } = parseArgs({
      args,
      options: { apply: { type: 'boolean' } },
      allowPositionals: false,
    })
    apply = values.apply === true
    if (positionals.length > 0) usage()
  } catch (error) {
    usage((error as Error).message)
  }
  const failReady = (message: string): never => fail(message, 'ready')

  let rules: ReadyRules | null = null
  try {
    rules = readyRules(loadConfig(cwd()).data)
  } catch (error) {
    if (error instanceof ConfigError) failReady(error.message)
    throw error
  }
  if (!rules) failReady('nothing to check: it reads a GitHub board with board.github.project and board.fields.status')
  const known = rules as ReadyRules
  const read = (repo: string) => {
    try {
      return readFirstStatus(ghGraphql, known, repo)
    } catch (error) {
      return failReady(`reading the board: ${(error as Error).message}`)
    }
  }

  let repo = ''
  try {
    repo = currentRepo()
  } catch (error) {
    failReady(
      `reading the repository: ${(error as Error).message}\n(gh repo set-default, or GITHUB_REPOSITORY, names it)`,
    )
  }
  const { project, status } = known
  const title = project.title ? ` (${project.title})` : ''
  const issues = read(repo)
  stdout.write(
    `lntt board ready: ${project.owner} project ${project.number}${title}, ${repo}, ${apply ? 'apply' : 'dry run'}\n`,
  )
  printReady(issues)
  const eligible = issues.filter((issue) => issue.verdict.kind === 'eligible')
  if (!apply) {
    if (eligible.length > 0) stdout.write(`run with --apply to move these to ${status.ready}\n`)
    return
  }
  eligible.forEach((issue, i) => {
    if (i > 0) pause(PAUSE_MS)
    try {
      moveToReady(ghGraphql, issue.target)
    } catch (error) {
      failReady(`#${issue.number}: ${(error as Error).message}\nmoved ${i} before it`)
    }
  })
  if (eligible.length > 0) {
    stdout.write(`moved ${eligible.length} issue${eligible.length === 1 ? '' : 's'} to ${status.ready}\n`)
    // Read back: every move must show, or the run says what did not.
    const after = new Set(read(repo).map((issue) => issue.number))
    const still = eligible.filter((issue) => after.has(issue.number))
    if (still.length > 0) {
      failReady(
        `still at ${status.initial} after --apply: ${still.map((issue) => `#${issue.number}`).join(', ')}\n` +
          '(a read right after a write can lag: run it again before changing anything)',
      )
    }
  }
}

export function main(args: string[]): void {
  if (args[0] === 'ready') {
    ready(args.slice(1))
    return
  }
  let mode: 'dry run' | 'apply' | 'check'
  try {
    const { values, positionals } = parseArgs({
      args,
      options: { apply: { type: 'boolean' }, check: { type: 'boolean' } },
      allowPositionals: true,
    })
    if (positionals.length !== 1 || positionals[0] !== 'sync') usage()
    if (values.apply && values.check) usage('--apply and --check do not go together')
    mode = values.apply ? 'apply' : values.check ? 'check' : 'dry run'
  } catch (error) {
    usage((error as Error).message)
  }

  let board: Parameters<typeof planBoard>[0]
  let project: { owner: string; ownerType?: string; number: number; title?: string }
  try {
    const data = loadConfig(cwd()).data
    board = getValue(data, 'board') as typeof board
    project = getValue(data, 'board.github.project') as typeof project
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message)
    throw error
  }

  // Any read of GitHub: a failure ends the run with gh's message.
  const guarded = <T>(f: () => T): T => {
    try {
      return f()
    } catch (error) {
      const message = (error as Error).message
      const hint = /resolve to an Organization/.test(message)
        ? '\n(board.github.project.ownerType defaults to organization: a Project of a user says "user")'
        : ''
      fail(`reading the board: ${message}${hint}`)
    }
  }
  const plan = () =>
    guarded(() => {
      const state = readBoard(ghGraphql, project)
      return { state, ...planBoard(board, state, counter(ghGraphql, state)) }
    })

  const { state, steps, manual } = plan()
  const title = project.title ? ` (${project.title})` : ''
  stdout.write(`lntt board sync: ${project.owner} project ${project.number}${title}, ${mode}\n`)
  stdout.write(steps.length ? steps.map((s) => `  ${describeStep(s)}\n`).join('') : '  nothing to change\n')

  if (mode !== 'apply') {
    printManual(manual)
    if (mode === 'check' && (steps.length || manual.length)) {
      fail(`the board differs from the configuration: ${steps.length} changes, ${manual.length} by hand`)
    }
    if (mode === 'dry run' && steps.length) stdout.write('run with --apply to make these changes\n')
    return
  }

  steps.forEach((step, i) => {
    if (i > 0) pause(PAUSE_MS)
    try {
      applyStep(ghGraphql, state, step)
    } catch (error) {
      printManual(manual)
      fail(`${describeStep(step)}: ${(error as Error).message}\napplied ${i} changes before it`)
    }
  })
  if (steps.length) stdout.write(`applied ${steps.length} changes\n`)
  // Read back: every change must show, or the run says what still differs.
  const after = plan()
  if (after.steps.length)
    fail(
      `still differs after --apply:\n${after.steps.map((s) => `  ${describeStep(s)}`).join('\n')}\n` +
        '(a read right after a write can lag: run it again before changing anything)',
    )
  printManual(after.manual)
}
