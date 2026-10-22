// `lntt pr`: the empty retrospective block of the configuration, and the check of a
// pull request body (usage: bin/lntt.ts).

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cwd, env, exit, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import { ConfigError } from './files.ts'
import { loadConfig } from './index.ts'
import { checkBody, type RetrospectiveRules, retrospectiveBlock, retrospectiveRules } from './pull-request.ts'

const USAGE = ['usage: lntt pr block', '       lntt pr check [--pr <n> | -]'].join('\n')

function usage(message?: string): never {
  if (message) stderr.write(`lntt pr: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

// A project without a configuration file still gets the default block.
function rules(): RetrospectiveRules {
  try {
    return retrospectiveRules(loadConfig(cwd()).data)
  } catch (error) {
    if (error instanceof ConfigError && /no \.agents\/config/.test(error.message)) return retrospectiveRules({})
    throw error
  }
}

// The body: stdin for `-`, else the pull request named, else the current branch's.
function readBody(args: string[]): string {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { pr: { type: 'string' } } })
  if (positionals.length > 1 || (positionals[0] !== undefined && positionals[0] !== '-'))
    usage('check takes --pr <n> or -')
  if (positionals[0] === '-') {
    if (values.pr !== undefined) usage('give --pr or -, not both')
    return readFileSync(0, 'utf8')
  }
  if (values.pr !== undefined && !/^[1-9]\d*$/.test(values.pr)) usage(`--pr takes a number, not ${values.pr}`)
  const view = ['pr', 'view', ...(values.pr === undefined ? [] : [values.pr]), '--json', 'body', '--jq', '.body']
  return execFileSync('gh', view, { cwd: cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

export function main(args: string[]): void {
  const [command, ...rest] = args
  if (command === 'block') {
    if (rest.length > 0) usage('block takes no argument')
    stdout.write(retrospectiveBlock(rules()))
    return
  }
  if (command !== 'check') usage(command === undefined ? undefined : `no command ${command}`)
  const problems = checkBody(readBody(rest), rules())
  for (const problem of problems) {
    // In Actions an annotation on the pull request; the step decides whether it gates.
    if (env.GITHUB_ACTIONS === 'true') stdout.write(`::warning title=Pull request body::${problem}\n`)
    else stderr.write(`lntt pr: ${problem}\n`)
  }
  if (problems.length > 0) exit(1)
}
