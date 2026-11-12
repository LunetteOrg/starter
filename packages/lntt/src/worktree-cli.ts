// `lntt worktree start`: an agent on an issue, in its own worktree, on the host the session runs in
// (usage: bin/lntt.ts). This module parses the arguments, reads the environment and the context
// file, and exits 2 on a usage error before Effect loads; the command runs on Effect
// (src/worktree/start.ts).

import { readFileSync } from 'node:fs'
import { env, stderr } from 'node:process'
import { parseArgs } from 'node:util'
import { exit } from './exit.ts'
import { pollInterval } from './messages-cli.ts'
import type { StartCommand } from './worktree/start.ts'
import { type Agent, type WorktreeHost, worktreeHost } from './worktree.ts'

const USAGE = [
  'usage: lntt worktree start --issue <n> [--issue <n>]... [--host orca|herdr|git] [--kind <agent>] [--model <id>] [--effort <level>] [--no-agent] [--base <branch>] [--prompt <text>]',
  '                           [--theme <slug> [--parent <worktree>] [--context <file>] [--size XS|S|M|L|XL] [--workflow]]',
  '       lntt worktree start --coordinator --theme <slug> --issue <n> [--issue <n>]... [--approve <n>]... [same options]',
].join('\n')
const HOSTS: WorktreeHost[] = ['orca', 'herdr', 'git']
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/

function usage(message?: string): never {
  if (message) stderr.write(`lntt worktree: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

function parse(args: string[]): StartCommand {
  const { values } = parseArgs({
    args,
    options: {
      issue: { type: 'string', multiple: true },
      host: { type: 'string' },
      kind: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      'no-agent': { type: 'boolean', default: false },
      base: { type: 'string' },
      prompt: { type: 'string' },
      coordinator: { type: 'boolean', default: false },
      theme: { type: 'string' },
      approve: { type: 'string', multiple: true },
      parent: { type: 'string' },
      context: { type: 'string' },
      size: { type: 'string' },
      workflow: { type: 'boolean', default: false },
    },
  })
  const issues = values.issue ?? []
  if (issues.length === 0) usage('give at least one --issue')
  for (const issue of issues) if (!/^[1-9]\d*$/.test(issue)) usage(`--issue takes a number, not ${issue}`)
  const host = (values.host ?? worktreeHost(env)) as WorktreeHost
  if (!HOSTS.includes(host)) usage(`--host is ${HOSTS.join(', ')}, not ${values.host}`)

  const { coordinator, theme } = values
  if (theme !== undefined && !SLUG.test(theme)) usage(`--theme is a slug (a-z, 0-9, -), not ${theme}`)
  if (coordinator && !theme) usage('--coordinator needs the theme: --theme <slug>')
  for (const flag of ['parent', 'context', 'size', 'workflow'] as const) {
    if (coordinator && values[flag]) usage(`--${flag} is a child’s: a coordinator has none`)
  }
  if (!coordinator && values.approve) usage('--approve is the coordinator’s: the children it may start at once')
  for (const flag of ['parent', 'context', 'size', 'workflow'] as const) {
    if (!coordinator && !theme && values[flag]) usage(`--${flag} needs the theme the child belongs to: --theme <slug>`)
  }
  const approve = (values.approve ?? []).map((raw) => {
    if (!issues.includes(raw)) usage(`--approve ${raw} is not one of the --issue of the theme`)
    return Number(raw)
  })
  let context: string | undefined
  if (values.context) {
    try {
      context = readFileSync(values.context, 'utf8')
    } catch (error) {
      stderr.write(`lntt worktree: ${(error as Error).message}\n`)
      exit(1)
    }
    if (!context.trim()) usage(`--context ${values.context} is empty`)
  }
  const given: Partial<Agent> = {
    ...(values.kind ? { kind: values.kind } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values.effort ? { effort: values.effort } : {}),
  }
  return {
    issues: issues.map(Number),
    host,
    given,
    noAgent: values['no-agent'],
    ...(values.base === undefined ? {} : { base: values.base }),
    ...(values.prompt === undefined ? {} : { prompt: values.prompt }),
    coordinator,
    ...(theme === undefined ? {} : { theme }),
    approve,
    ...(values.parent ? { parent: values.parent } : {}),
    ...(context === undefined ? {} : { context }),
    ...(values.size ? { size: values.size } : {}),
    workflow: values.workflow,
    pollMs: pollInterval(),
  }
}

export async function main([command, ...args]: string[]): Promise<void> {
  if (command !== 'start') usage()
  let parsed: StartCommand
  try {
    parsed = parse(args)
  } catch (error) {
    if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')) {
      usage(error.message)
    }
    throw error
  }
  const { runStart } = await import('./worktree/start.ts')
  await runStart(parsed, env.LNTT_MESSAGES_DIR || undefined)
}
