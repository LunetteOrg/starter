// `lntt branch`: the branch name an issue gets, a check of the current branch, and the rename that
// fixes the name a tool gave it (usage: bin/lntt.ts). This module parses the arguments, exit 2
// before Effect loads; the command, which also reads the pre-push hook's stdin, runs on Effect
// (src/branch/command.ts).

import { env, stderr } from 'node:process'
import { parseArgs } from 'node:util'
import type { BranchCommand } from './branch/command.ts'
import { exit } from './exit.ts'
import { detectHost } from './viewer.ts'

const USAGE = [
  'usage: lntt branch name (--issue <n> | --type <type> --slug <slug>) [--type <type>] [--slug <slug>]',
  '       lntt branch check [--branch <name>]',
  '       lntt branch rename',
].join('\n')

function usage(message?: string): never {
  if (message) stderr.write(`lntt branch: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

// A command from its arguments: usage, exit 2, before Effect loads.
async function parse(command: string | undefined, args: string[]): Promise<BranchCommand> {
  if (command === 'name') {
    const { values } = parseArgs({
      args,
      options: { issue: { type: 'string' }, type: { type: 'string' }, slug: { type: 'string' } },
    })
    const overrides = {
      ...(values.type ? { type: values.type } : {}),
      ...(values.slug ? { slug: values.slug } : {}),
    }
    if (values.issue !== undefined) {
      if (!/^[1-9]\d*$/.test(values.issue)) usage(`--issue takes a number, not ${values.issue}`)
      return { kind: 'name', issue: Number(values.issue), ...overrides }
    }
    if (!values.type || !values.slug) usage('without --issue, give --type and --slug')
    return { kind: 'name', issue: null, ...overrides }
  }
  if (command === 'check') {
    const { values } = parseArgs({
      args,
      options: { branch: { type: 'string' }, 'pre-push': { type: 'boolean', default: false } },
    })
    if (values['pre-push']) return { kind: 'check', fromStdin: true }
    return { kind: 'check', ...(values.branch ? { branch: values.branch } : {}) }
  }
  if (command === 'rename') return { kind: 'rename', host: detectHost(env) }
  usage()
}

export async function main([command, ...args]: string[]): Promise<void> {
  let parsed: BranchCommand
  try {
    parsed = await parse(command, args)
  } catch (error) {
    if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')) {
      usage(error.message)
    }
    throw error
  }
  const { runBranch } = await import('./branch/command.ts')
  return runBranch(parsed)
}
