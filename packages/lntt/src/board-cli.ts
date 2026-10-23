// `lntt board sync [--apply]`: the Project and the issue types brought to the board
// section (src/board.ts; usage: bin/lntt.ts). A dry run unless --apply.

import { cwd, exit, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import { applyStep, type BoardState, describeStep, ghGraphql, type Manual, planBoard, readBoard } from './board.ts'
import { ConfigError, getValue, loadConfig } from './index.ts'

const USAGE = 'usage: lntt board sync [--apply]'
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
  stdout.write(`by hand, in GitHub's UI:\n${manual.map((m) => `  ${m.what}: ${m.why}\n`).join('')}`)
}

export function main(args: string[]): void {
  let apply: boolean
  try {
    const { values, positionals } = parseArgs({ args, options: { apply: { type: 'boolean' } }, allowPositionals: true })
    if (positionals.length !== 1 || positionals[0] !== 'sync') usage()
    apply = values.apply ?? false
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

  const read = (): BoardState => {
    try {
      return readBoard(ghGraphql, project)
    } catch (error) {
      fail(`reading the board: ${(error as Error).message}`)
    }
  }
  const state = read()
  const { steps, manual } = planBoard(board, state)
  const title = project.title ? ` (${project.title})` : ''
  stdout.write(`lntt board sync: ${project.owner} project ${project.number}${title}, ${apply ? 'apply' : 'dry run'}\n`)
  stdout.write(steps.length ? steps.map((s) => `  ${describeStep(s)}\n`).join('') : '  nothing to change\n')

  if (!apply) {
    printManual(manual)
    if (steps.length) stdout.write('run with --apply to make these changes\n')
    return
  }

  steps.forEach((step, i) => {
    if (i > 0) pause(PAUSE_MS)
    try {
      applyStep(ghGraphql, state, step)
    } catch (error) {
      fail(`${describeStep(step)}: ${(error as Error).message}\napplied ${i} changes before it`)
    }
  })
  if (steps.length) stdout.write(`applied ${steps.length} changes\n`)
  // Read back: every change must show, or the run says what still differs.
  const after = planBoard(board, read())
  if (after.steps.length)
    fail(`still differs after --apply:\n${after.steps.map((s) => `  ${describeStep(s)}`).join('\n')}`)
  printManual(after.manual)
}
