// `lntt check`: every configured area, one area, or one of its checks; `cite` prints
// what is on lines (usage: bin/lntt.ts).

import { dirname } from 'node:path'
import { cwd, exit, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import { AREAS, citeAll, failed, formatJson, formatText, isArea, type Result, runArea } from './check.ts'
import { ConfigError, loadConfig } from './index.ts'

const USAGE = `usage: lntt check [agents-md | decisions [structure | numbers [<file>...]]] [--base <ref>] [--json]
       lntt check cite <path:line>... [--json]`

function usage(message?: string): never {
  if (message) stderr.write(`lntt check: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

const CHECKS: Record<string, string[]> = { 'agents-md': [], decisions: ['structure', 'numbers'] }

function run(args: string[]): Result[] {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { base: { type: 'string' }, json: { type: 'boolean', default: false } },
  })
  const [area, check, ...rest] = positionals
  // The root of the project whose configuration is read, as `lntt sync` writes it.
  const loaded = loadConfig(cwd())
  const root = dirname(dirname(loaded.path))
  if (area === 'cite') {
    const anchors = positionals.slice(1)
    if (anchors.length === 0) usage('give at least one path:line')
    const bad = anchors.find((a) => !/^.+:\d+$/.test(a))
    if (bad) usage(`${bad} is not path:line`)
    return citeAll(root, anchors)
  }
  const options = { root, data: loaded.data, ...(values.base === undefined ? {} : { base: values.base }) }
  if (area === undefined) return AREAS.flatMap((a) => runArea(a, undefined, [], options))
  if (!isArea(area)) usage(`no area ${area}: ${[...AREAS, 'cite'].join(', ')}`)
  if (check !== undefined && !(CHECKS[area] as string[]).includes(check)) {
    usage(`no check ${check} in ${area}${CHECKS[area]?.length ? `: ${CHECKS[area]?.join(', ')}` : ''}`)
  }
  if (rest.length > 0 && check !== 'numbers') usage(`${check ?? area} takes no file`)
  if (check === 'numbers' && rest.length === 0 && values.base === undefined) usage('numbers needs files or --base')
  return runArea(area, check, rest, options)
}

export function main(args: string[]): void {
  let results: Result[]
  try {
    results = run(args)
  } catch (error) {
    if (error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')) {
      usage(error.message)
    }
    if (!(error instanceof ConfigError)) throw error
    stderr.write(`lntt: ${error.message}\n`)
    exit(1)
  }
  stdout.write(args.includes('--json') ? formatJson(results) : formatText(results))
  exit(failed(results) ? 1 : 0)
}
