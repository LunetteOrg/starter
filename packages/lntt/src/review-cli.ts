// `lntt review`: one review round on the current branch, an answer to a reviewer, more rounds,
// and what the review store keeps (usage: bin/lntt.ts). Every subcommand runs on Effect: a round,
// a reply and allow in src/review/command.ts, status and cost in src/review/status.ts. This module
// parses the arguments, a usage error exiting 2 before Effect loads.

import { homedir } from 'node:os'
import { env, stderr } from 'node:process'
import { parseArgs } from 'node:util'
import { exit } from './exit.ts'
import type { ReviewCommand } from './review/command.ts'
import type { StatusCommand } from './review/status.ts'

const USAGE = `usage: lntt review [--base <branch>] [--plan]
       lntt review reply <finding> <answer>
       lntt review allow <rounds>
       lntt review status [--json] [--query <jq>] [--clear | --prune [--dry-run]]
       lntt review cost [--json] [--query <jq>]`

function usage(message?: string): never {
  if (message) stderr.write(`lntt review: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

export async function main([command, ...args]: string[]): Promise<void> {
  try {
    if (command === 'status' || command === 'cost') {
      const parsed = command === 'status' ? statusCommand(args) : costCommand(args)
      const { runStatus } = await import('./review/status.ts')
      return runStatus(parsed, homedir())
    }
    const parsed = parseCommand(command, args)
    // A round, a reply or allow holds the worktree's lock, a round or a reply its agents: they
    // run on Effect, which releases both however the command ends (src/review/command.ts).
    const { runReview } = await import('./review/command.ts')
    return runReview(parsed, homedir(), env)
  } catch (error) {
    if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')) {
      usage(error.message)
    }
    throw error
  }
}

function statusCommand(args: string[]): StatusCommand {
  const { values } = parseArgs({
    args,
    options: {
      json: { type: 'boolean', default: false },
      clear: { type: 'boolean', default: false },
      prune: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      query: { type: 'string' },
    },
  })
  if (values.clear && values.json) usage('--clear does not take --json')
  if (values.clear && values.query !== undefined) usage('--clear does not take --query')
  if (values.prune && (values.clear || values.json || values.query !== undefined)) {
    usage('--prune takes only --dry-run')
  }
  if (values['dry-run'] && !values.prune) usage('--dry-run goes with --prune')
  return {
    kind: 'status',
    json: values.json,
    clear: values.clear,
    prune: values.prune,
    dryRun: values['dry-run'],
    ...(values.query === undefined ? {} : { query: values.query }),
  }
}

function costCommand(args: string[]): StatusCommand {
  const { values } = parseArgs({
    args,
    options: { json: { type: 'boolean', default: false }, query: { type: 'string' } },
  })
  return { kind: 'cost', json: values.json, ...(values.query === undefined ? {} : { query: values.query }) }
}

// A round, a reply or allow, from its arguments: usage, exit 2, before Effect loads.
function parseCommand(command: string | undefined, args: string[]): ReviewCommand {
  if (command === 'reply') {
    const [id, ...words] = args
    if (!id || words.length === 0) usage('give the finding and the answer')
    return { kind: 'reply', id, answer: words.join(' ') }
  }
  if (command === 'allow') {
    const [count, ...rest] = args
    if (rest.length > 0 || !count || !/^\d+$/.test(count) || Number(count) < 1)
      usage('give the rounds to allow, a whole number from 1')
    return { kind: 'allow', rounds: Number(count) }
  }
  const { values } = parseArgs({
    args: command === undefined ? [] : [command, ...args],
    options: { base: { type: 'string' }, plan: { type: 'boolean', default: false } },
  })
  return { kind: 'round', base: values.base, plan: values.plan }
}
