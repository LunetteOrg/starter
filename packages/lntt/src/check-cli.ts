// `lntt check`: every configured area, one area, or one of its checks; `cite` prints
// what is on lines (usage: bin/lntt.ts).

import { dirname } from 'node:path'
import { cwd, exit, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import {
  ANCHOR_LINE,
  AREAS,
  type Area,
  CannotRunError,
  citeAll,
  failed,
  formatJson,
  formatText,
  isArea,
  type Result,
  runArea,
} from './check.ts'
import { ConfigError, loadConfig } from './index.ts'

const USAGE = `usage: lntt check [agents-md | skills | decisions [structure | numbers [<file>...]] | tests [levels | focus | rules | touched]] [--base <ref>] [--json]
       lntt check tests mutate <path:line> --text <on the line> --to <mutated> [--json]
       lntt check cite <path:line>... [--json]`

function usage(message?: string): never {
  if (message) stderr.write(`lntt check: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

const CHECKS: Record<string, string[]> = {
  'agents-md': [],
  skills: [],
  decisions: ['structure', 'numbers'],
  tests: ['levels', 'focus', 'rules', 'touched', 'mutate'],
}

function run(args: string[]): Result[] {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      json: { type: 'boolean', default: false },
      text: { type: 'string' },
      to: { type: 'string' },
    },
  })
  // Every argument is checked before the configuration is read: a usage error is one
  // in any project.
  const [area, check, ...rest] = positionals
  const { base } = values
  if (base !== undefined && (base === '' || base.startsWith('-'))) usage(`--base ${base || "''"} is not a ref`)
  if (area === 'cite') {
    const anchors = positionals.slice(1)
    if (anchors.length === 0) usage('give at least one path:line')
    const bad = anchors.find((a) => !ANCHOR_LINE.test(a))
    if (bad) usage(`${bad} is not path:line`)
  } else if (area !== undefined) {
    if (!isArea(area)) usage(`no area ${area}: ${[...AREAS, 'cite'].join(', ')}`)
    if (check !== undefined && !(CHECKS[area] as string[]).includes(check)) {
      usage(`no check ${check} in ${area}${CHECKS[area]?.length ? `: ${CHECKS[area]?.join(', ')}` : ''}`)
    }
    if (rest.length > 0 && check !== 'numbers' && check !== 'mutate') usage(`${check ?? area} takes no file`)
    if (check === 'numbers' && rest.length === 0 && base === undefined) usage('numbers needs files or --base')
    if (check === 'mutate') {
      if (rest.length !== 1 || !ANCHOR_LINE.test(rest[0] as string)) usage('mutate needs one path:line')
      if (values.text === undefined || values.text === '' || values.to === undefined) {
        usage('mutate needs --text <what is on the line> and --to <what it becomes>')
      }
    } else if (values.text !== undefined || values.to !== undefined) usage('--text and --to are for tests mutate')
  }
  // The root of the project whose configuration is read, as `lntt sync` writes it.
  const loaded = loadConfig(cwd())
  const root = dirname(dirname(loaded.path))
  if (area === 'cite') return citeAll(root, positionals.slice(1))
  const options = {
    root,
    data: loaded.data,
    ...(base === undefined ? {} : { base }),
    ...(values.text === undefined ? {} : { mutation: { text: values.text, to: values.to as string } }),
  }
  if (area === undefined) return AREAS.flatMap((a) => runArea(a, undefined, [], options))
  return runArea(area as Area, check, rest, options)
}

// The line an error is reported with: a configuration error, or a check that could not
// run at all. null for anything else, a defect of lntt, which keeps its stack.
export function errorLine(error: unknown): string | null {
  if (error instanceof CannotRunError) return `lntt: error: ${error.message}`
  if (error instanceof ConfigError) return `lntt: ${error.message}`
  return null
}

// `checks` is the run itself; a test gives another.
export function main(args: string[], checks: (args: string[]) => Result[] = run): void {
  let results: Result[]
  try {
    results = checks(args)
  } catch (error) {
    if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')) {
      usage(error.message)
    }
    const line = errorLine(error)
    if (line === null) throw error
    stderr.write(`${line}\n`)
    exit(1)
  }
  stdout.write(args.includes('--json') ? formatJson(results) : formatText(results))
  exit(failed(results) ? 1 : 0)
}
