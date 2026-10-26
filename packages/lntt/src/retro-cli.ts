// `lntt retro add`: one item under one label of the candidate's retrospective comment,
// written when the friction is met (usage: bin/lntt.ts).

import { cwd, env, exit, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import { makeGh } from './ci/candidate.ts'
import { candidateConfig } from './ci/config.ts'
import { loadConfig } from './index.ts'
import { retrospectiveRules } from './pull-request.ts'
import { retroAdd } from './retro.ts'

const USAGE = 'usage: lntt retro add --label <label> [--pr <n>] [--dry-run] <one sentence>'

function usage(message?: string): never {
  if (message) stderr.write(`lntt retro: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

export function main(args: string[]): void {
  const [command, ...rest] = args
  if (command !== 'add') usage(command === undefined ? undefined : `no command ${command}`)
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(rest)
  } catch (error) {
    usage((error as Error).message)
  }
  const { values, positionals } = parsed
  if (values.label === undefined || values.label.trim() === '') usage('add needs --label <label>')
  if (positionals.length === 0) usage('add needs the item: one sentence')
  if (values.pr !== undefined && !/^[1-9]\d*$/.test(values.pr)) usage(`--pr takes a number, not ${values.pr}`)
  const log = (line: string) => stdout.write(`${line}\n`)
  try {
    const rules = retrospectiveRules(loadConfig(cwd()).data)
    const gh = makeGh({ dryRun: values['dry-run'], log })
    const repo = env.GITHUB_REPOSITORY ?? gh.read(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
    const { pr, label, created } = retroAdd(
      { gh, repo, config: candidateConfig(cwd()), rules },
      {
        ...(values.pr === undefined ? {} : { pr: Number(values.pr) }),
        label: values.label,
        item: positionals.join(' '),
      },
    )
    log(
      `retro: ${values['dry-run'] ? 'would add' : 'added'} under "${label}" on #${pr}${created ? ', in a new retrospective comment' : ''}.`,
    )
  } catch (error) {
    // A refusal, a configuration error or a failed gh: one line, no stack.
    if (!(error instanceof Error)) throw error
    stderr.write(`lntt retro: ${error.message}\n`)
    exit(1)
  }
}

function parse(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      label: { type: 'string' },
      pr: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  })
}
