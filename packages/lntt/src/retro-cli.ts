// `lntt retro add`: one item under one label of the candidate's retrospective comment,
// written when the friction is met (usage: bin/lntt.ts). This module parses the arguments, exit 2
// before Effect loads; the command runs on Effect (src/retro/command.ts).

import { cwd, env, stderr } from 'node:process'
import { parseArgs } from 'node:util'
import { retrospectiveComment } from './ci/candidate.ts'
import { candidateConfig } from './ci/config.ts'
import { exit } from './exit.ts'
import { loadConfig } from './index.ts'
import { retrospectiveRules } from './pull-request.ts'
import type { RetroCommand, RetroProject } from './retro/command.ts'

const USAGE = 'usage: lntt retro add --label <label> [--pr <n>] [--dry-run] <one sentence>'

function usage(message?: string): never {
  if (message) stderr.write(`lntt retro: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

// The project's configuration, for the command on Effect (its ProjectData).
export function projectData(): RetroProject {
  const rules = retrospectiveRules(loadConfig(cwd()).data)
  const config = candidateConfig(cwd())
  return { rules, candidate: config === null ? null : { config, comment: retrospectiveComment(config) } }
}

// A command from its arguments: usage, exit 2, before Effect loads.
function parse([command, ...rest]: string[]): RetroCommand {
  if (command !== 'add') usage(command === undefined ? undefined : `no command ${command}`)
  let parsed: ReturnType<typeof options>
  try {
    parsed = options(rest)
  } catch (error) {
    usage((error as Error).message)
  }
  const { values, positionals } = parsed
  if (values.label === undefined || values.label.trim() === '') usage('add needs --label <label>')
  if (positionals.length === 0) usage('add needs the item: one sentence')
  if (values.pr !== undefined && !/^[1-9]\d*$/.test(values.pr)) usage(`--pr takes a number, not ${values.pr}`)
  const repository = env.GITHUB_REPOSITORY
  return {
    kind: 'add',
    label: values.label,
    item: positionals.join(' '),
    dryRun: values['dry-run'],
    ...(values.pr === undefined ? {} : { pr: Number(values.pr) }),
    ...(repository ? { repository } : {}),
  }
}

function options(args: string[]) {
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

export async function main(args: string[]): Promise<void> {
  const parsed = parse(args)
  const { runRetro } = await import('./retro/command.ts')
  return runRetro(parsed)
}
