// `lntt check`: every configured area, one area, or one of its checks; `cite` prints
// what is on lines (usage: bin/lntt.ts).

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
import { comments } from './ci/candidate.ts'
import { candidateConfig } from './ci/config.ts'
import { ConfigError, loadConfig } from './index.ts'
import { retroComment } from './pull-request.ts'
import { isCandidate } from './retro.ts'

const USAGE = `usage: lntt check [agents-md | skills | decisions [structure | board-refs [<file>...] | numbers [<file>...]] | tests [levels | focus | rules | touched] | body [template | --pr <n> | -]] [--base <ref>] [--json]
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
  decisions: ['structure', 'board-refs', 'numbers'],
  tests: ['levels', 'focus', 'rules', 'touched', 'mutate'],
  body: ['-', 'template'],
}

// The text the body area's retrospective check reads: stdin for `-`, else the pull request
// named, else the current branch's, read with gh. A candidate's block is not in its body,
// which the automation rebuilds at every squash, but in its retrospective comment.
function readBody(check: string | undefined, pr: string | undefined): { text: string; from: string } {
  if (check === '-') return { text: readFileSync(0, 'utf8'), from: 'stdin' }
  const view = ['pr', 'view', ...(pr === undefined ? [] : [pr]), '--json', 'number,body,headRefName']
  const read = (args: string[]) => {
    try {
      return execFileSync('gh', args, { cwd: cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      const said = (error as { stderr?: string }).stderr?.trim().split('\n')[0]
      throw new CannotRunError(`gh ${args.join(' ')} failed${said ? `: ${said}` : ''}`)
    }
  }
  let found: { number: number; body: string | null; headRefName: string }
  try {
    found = JSON.parse(read(view))
  } catch (error) {
    if (error instanceof CannotRunError) throw error
    throw new CannotRunError(`gh ${view.join(' ')} printed no JSON`)
  }
  if (isCandidate(candidateConfig(cwd()), found.headRefName)) {
    const gh = { read: (args: string[]) => read(args).trim(), write: () => '' }
    const comment = retroComment(comments(gh, '{owner}/{repo}', found.number))
    return {
      text: comment?.body ?? '',
      from: `${comment === null ? 'the comments' : 'the retrospective comment'} of candidate #${found.number}`,
    }
  }
  return {
    text: found.body ?? '',
    from: pr === undefined ? "the current branch's pull request" : `pull request #${pr}`,
  }
}

function run(args: string[]): Result[] {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      base: { type: 'string' },
      json: { type: 'boolean', default: false },
      pr: { type: 'string' },
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
    if (rest.length > 0 && check !== 'numbers' && check !== 'board-refs' && check !== 'mutate')
      usage(`${check ?? area} takes no file`)
    if (check === 'numbers' && rest.length === 0 && base === undefined) usage('numbers needs files or --base')
    if (check === 'mutate') {
      if (rest.length !== 1 || !ANCHOR_LINE.test(rest[0] as string)) usage('mutate needs one path:line')
      if (values.text === undefined || values.text === '' || values.to === undefined) {
        usage('mutate needs --text <what is on the line> and --to <what it becomes>')
      }
    } else if (values.text !== undefined || values.to !== undefined) usage('--text and --to are for tests mutate')
  }
  if (values.pr !== undefined) {
    if (area !== 'body') usage('--pr is for body')
    if (check === '-') usage('give --pr <n> or -, not both')
    if (check === 'template') usage('template reads the repository, not a pull request')
    if (!/^[1-9]\d*$/.test(values.pr)) usage(`--pr takes a number, not ${values.pr}`)
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
    ...(area === 'body' && check !== 'template' ? { body: readBody(check, values.pr) } : {}),
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
