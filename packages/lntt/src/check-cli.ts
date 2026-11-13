// `lntt check`: every configured area, one area, or one of its checks; `cite` prints what is on
// lines (usage: bin/lntt.ts). This module parses the arguments, exit 2 before Effect loads, and
// reads stdin for `body -`; the command runs on Effect (src/check/command.ts).

import { cwd, stderr } from 'node:process'
import { parseArgs } from 'node:util'
import type { CheckCommand } from './check/command.ts'
import { ANCHOR_LINE, AREAS, type Area, CHECKS, isArea } from './check/results.ts'
import { exit } from './exit.ts'
import { readStdin } from './stdin.ts'

const USAGE = `usage: lntt check [agents-md | skills | plugin | workflows [automated] | decisions [structure | board-refs [<file>...] | numbers [<file>...]] | tests [levels | focus | rules | touched] | body [template | --pr <n> | -]] [--base <ref>] [--json] [--query <jq>]
       lntt check tests mutate <path:line> --text <on the line> --to <mutated> --test <test file>... [--json]
       lntt check cite <path:line>... [--json]
       --query <jq>: a jq expression on each line --json prints, its result instead`

function usage(message?: string): never {
  if (message) stderr.write(`lntt check: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

// A command from its arguments: every argument is checked before the configuration is read, so a
// usage error is one in any project.
export async function parse(args: string[]): Promise<CheckCommand> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      json: { type: 'boolean', default: false },
      pr: { type: 'string' },
      query: { type: 'string' },
      text: { type: 'string' },
      to: { type: 'string' },
      test: { type: 'string', multiple: true },
    },
  })
  const [area, check, ...rest] = positionals
  const { base } = values
  if (base !== undefined && (base === '' || base.startsWith('-'))) usage(`--base ${base || "''"} is not a ref`)
  const common = {
    cwd: cwd(),
    json: values.json,
    ...(base === undefined ? {} : { base }),
    ...(values.query === undefined ? {} : { query: values.query }),
  }
  if (area === 'cite') {
    const anchors = positionals.slice(1)
    if (anchors.length === 0) usage('give at least one path:line')
    const bad = anchors.find((a) => !ANCHOR_LINE.test(a))
    if (bad) usage(`${bad} is not path:line`)
    if (values.pr !== undefined) usage('--pr is for body')
    return { kind: 'cite', anchors, ...common }
  }
  if (area !== undefined) {
    if (!isArea(area)) usage(`no area ${area}: ${[...AREAS, 'cite'].join(', ')}`)
    const checks = CHECKS[area]
    if (check !== undefined && !checks.includes(check)) {
      usage(`no check ${check} in ${area}${checks.length ? `: ${checks.join(', ')}` : ''}`)
    }
    if (rest.length > 0 && check !== 'numbers' && check !== 'board-refs' && check !== 'mutate')
      usage(`${check ?? area} takes no file`)
    if (check === 'numbers' && rest.length === 0 && base === undefined) usage('numbers needs files or --base')
    if (check === 'mutate') {
      if (rest.length !== 1 || !ANCHOR_LINE.test(rest[0] as string)) usage('mutate needs one path:line')
      if (values.text === undefined || values.text === '' || values.to === undefined) {
        usage('mutate needs --text <what is on the line> and --to <what it becomes>')
      }
      if (values.test === undefined || values.test.some((t) => t === '' || t.startsWith('-'))) {
        usage('mutate needs --test <test file>, once for each test file to run')
      }
    } else if (values.text !== undefined || values.to !== undefined || values.test !== undefined) {
      usage('--text, --to and --test are for tests mutate')
    }
  }
  if (values.pr !== undefined) {
    if (area !== 'body') usage('--pr is for body')
    if (check === '-') usage('give --pr <n> or -, not both')
    if (check === 'template') usage('template reads the repository, not a pull request')
    if (!/^[1-9]\d*$/.test(values.pr)) usage(`--pr takes a number, not ${values.pr}`)
  }
  if (area === undefined) return { kind: 'all', ...common }
  if (check === 'mutate') {
    return {
      kind: 'mutate',
      anchor: rest[0] as string,
      text: values.text as string,
      to: values.to as string,
      tests: values.test ?? [],
      ...common,
    }
  }
  const body =
    area !== 'body' || check === 'template'
      ? {}
      : {
          body: check === '-' ? { stdin: await readStdin() } : values.pr === undefined ? {} : { pr: Number(values.pr) },
        }
  return {
    kind: 'area',
    area: area as Area,
    ...(check === undefined ? {} : { check }),
    files: rest,
    ...body,
    ...common,
  }
}

export async function main(args: string[]): Promise<void> {
  let parsed: CheckCommand
  try {
    parsed = await parse(args)
  } catch (error) {
    if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')) {
      usage(error.message)
    }
    throw error
  }
  const { runCheck } = await import('./check/command.ts')
  return runCheck(parsed)
}
