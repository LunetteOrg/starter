// `lntt board sync [--apply | --check]`: the Project and the issue types brought to the
// board section (src/board.ts; usage: bin/lntt.ts). A dry run unless --apply; --check
// exits 1 when the board differs, for a hook or a scheduled job.
//
// `lntt board ready [--apply]`: the issues at the first status, Ready-eligible or with
// what is missing (src/board-ready.ts). A dry run unless --apply, which moves the
// eligible ones and reads the board back.
//
// This module parses the arguments, exit 2 before Effect loads; the command runs on Effect
// (src/board/command.ts).

import { cwd, env, stderr } from 'node:process'
import { parseArgs } from 'node:util'
import type { BoardCommand } from './board/command.ts'
import { Exit, exit } from './exit.ts'
import { loadConfig } from './index.ts'

const USAGE = 'usage: lntt board sync [--apply | --check]\n       lntt board ready [--apply]'

function usage(message?: string): never {
  if (message) stderr.write(`lntt board: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

// The project's configuration, for the command on Effect (its ProjectData).
export function projectData(): Record<string, unknown> {
  return loadConfig(cwd()).data
}

// A command from its arguments: usage, exit 2, before Effect loads.
function parse(args: string[]): BoardCommand {
  try {
    if (args[0] === 'ready') {
      const { values } = parseArgs({
        args: args.slice(1),
        options: { apply: { type: 'boolean' } },
        allowPositionals: false,
      })
      const repository = env.GITHUB_REPOSITORY
      return { kind: 'ready', apply: values.apply === true, ...(repository ? { repository } : {}) }
    }
    const { values, positionals } = parseArgs({
      args,
      options: { apply: { type: 'boolean' }, check: { type: 'boolean' } },
      allowPositionals: true,
    })
    if (positionals.length !== 1 || positionals[0] !== 'sync') usage()
    if (values.apply && values.check) usage('--apply and --check do not go together')
    return { kind: 'sync', mode: values.apply ? 'apply' : values.check ? 'check' : 'dry run' }
  } catch (error) {
    if (error instanceof Exit) throw error
    usage((error as Error).message)
  }
}

export async function main(args: string[]): Promise<void> {
  const parsed = parse(args)
  const { runBoard } = await import('./board/command.ts')
  return runBoard(parsed)
}
