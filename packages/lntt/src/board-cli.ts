// `lntt board sync [--apply | --check]`: the Project and the issue types brought to the
// board section (src/board.ts; usage: bin/lntt.ts). A dry run unless --apply; --check
// exits 1 when the board differs, for CI or a hook.

import { cwd, exit, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import { applyStep, counter, describeStep, ghGraphql, type Manual, planBoard, readBoard } from './board.ts'
import { ConfigError, getValue, loadConfig } from './index.ts'

const USAGE = 'usage: lntt board sync [--apply | --check]'
// Between two writes: GitHub's secondary rate limit drops writes sent faster, and does
// not show in rate_limit.
const PAUSE_MS = 1200

function usage(message?: string): never {
  if (message) stderr.write(`lntt board: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

function fail(message: string): never {
  stderr.write(`lntt board sync: ${message}\n`)
  exit(1)
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function printManual(manual: Manual[]): void {
  if (manual.length === 0) return
  const entry = (m: Manual) =>
    `  ${m.what}: ${m.why}\n${m.url ? `    ${m.url}\n` : ''}${m.steps.map((s, i) => `    ${i + 1}. ${s}\n`).join('')}`
  stdout.write(`by hand, in GitHub's UI:\n${manual.map(entry).join('')}`)
}

export function main(args: string[]): void {
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
