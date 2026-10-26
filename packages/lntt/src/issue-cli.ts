// `lntt dump` and `lntt issue`: a report on Lunette itself, its environment collected and
// redacted, filed on the Lunette repository once the operator has read it (usage:
// bin/lntt.ts).

import { readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { cwd, env, exit, stderr, stdin, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import { makeGh } from './ci/candidate.ts'
import { collectDump, type Dump, packageJson, renderDump, runFailing } from './dump.ts'
import { findConfig, loadConfig, NoConfigError } from './index.ts'
import { commentIssue, fileIssue, issueBody, parseDraft, searchIssues, upstreamRepository } from './issue.ts'

const USAGE = [
  'usage: lntt dump [--json] [--harness <name>] [--model <id>] [-- <failing command>...]',
  '       lntt issue <draft.md | -> [--dump <dump.json>] [--harness <name>] [--model <id>] [--project <name>]',
  '                  [--comment <n>] [--send]',
  '       lntt issue search <words>...',
].join('\n')

function usage(message?: string): never {
  if (message) stderr.write(`lntt: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

export function main(command: 'dump' | 'issue', args: string[]): void {
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(args)
  } catch (error) {
    usage((error as Error).message)
  }
  try {
    if (command === 'dump') dump(parsed)
    else issue(parsed)
  } catch (error) {
    // A refusal, a configuration error or a failed gh: one line, no stack.
    if (!(error instanceof Error)) throw error
    stderr.write(`lntt ${command}: ${error.message}\n`)
    exit(1)
  }
}

// The project's root: the directory of .agents/, else the current one.
function projectRoot(): string {
  try {
    return dirname(dirname(findConfig(cwd()).path))
  } catch (error) {
    if (error instanceof NoConfigError) return cwd()
    throw error
  }
}

// The configuration, or none: a project without one reports with the defaults.
function projectConfig(): Record<string, unknown> {
  try {
    return loadConfig(cwd()).data
  } catch (error) {
    if (error instanceof NoConfigError) return {}
    throw error
  }
}

function dump({ values, positionals }: Parsed): void {
  const root = projectRoot()
  const failing = values.failing
  if (failing === undefined && positionals.length > 0) usage('the failing command goes after --')
  for (const flag of ['dump', 'project', 'comment', 'send'] as const) {
    if (values[flag] !== undefined && values[flag] !== false) usage(`--${flag} is an option of lntt issue`)
  }
  const result = collectDump({
    root,
    env,
    ...(values.harness === undefined ? {} : { harness: values.harness }),
    ...(values.model === undefined ? {} : { model: values.model }),
    ...(failing === undefined ? {} : { command: runFailing(failing, cwd()) }),
  })
  stdout.write(values.json ? `${JSON.stringify(result)}\n` : renderDump(result))
}

function issue({ values, positionals }: Parsed): void {
  if (values.failing !== undefined) usage('lntt issue takes no command after --: lntt dump does')
  if (values.json) usage('--json is an option of lntt dump')
  const [first, ...rest] = positionals
  const repo = upstreamRepository(projectConfig(), packageJson())
  const gh = makeGh({ dryRun: false, log: (line) => stderr.write(`${line}\n`) })
  if (first === 'search') {
    if (rest.length === 0) usage('search needs the words to look for')
    for (const found of searchIssues(gh, repo, rest.join(' '))) stdout.write(`${JSON.stringify(found)}\n`)
    return
  }
  if (first === undefined || rest.length > 0) usage('issue takes one draft: a file, or - for stdin')
  if (values.comment !== undefined && !/^[1-9]\d*$/.test(values.comment)) {
    usage(`--comment takes an issue number, not ${values.comment}`)
  }
  const draft = parseDraft(readFileSync(first === '-' ? stdin.fd : first, 'utf8'))
  const root = projectRoot()
  const result: Dump =
    values.dump === undefined
      ? collectDump({
          root,
          env,
          ...(values.harness === undefined ? {} : { harness: values.harness }),
          ...(values.model === undefined ? {} : { model: values.model }),
        })
      : readDump(values.dump)
  const project = values.project ?? projectName(root)
  const body = issueBody(draft, result, project)
  const comment = values.comment === undefined ? undefined : Number(values.comment)

  if (!values.send) {
    const where = comment === undefined ? `To ${repo}: ${draft.title}` : `To ${repo}#${comment}, as a comment`
    stdout.write(`${where}\n\n${body}`)
    stderr.write('lntt issue: nothing sent: --send opens it, once the operator has read it\n')
    return
  }
  const url = comment === undefined ? fileIssue(gh, repo, draft.title, body) : commentIssue(gh, repo, comment, body)
  stdout.write(`${url}\n`)
}

function readDump(path: string): Dump {
  const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<Dump>
  if (!Array.isArray(data.sections) || typeof data.harness !== 'string' || typeof data.model !== 'string') {
    throw new Error(`${path} is not a dump of lntt dump --json`)
  }
  return data as Dump
}

function projectName(root: string): string {
  try {
    const name = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')).name
    if (typeof name === 'string' && name !== '') return name
  } catch {}
  return basename(root)
}

type Parsed = ReturnType<typeof parse>

// Everything after `--` is the failing command, kept apart from lntt's own options.
function parse(args: string[]) {
  const at = args.indexOf('--')
  const own = at === -1 ? args : args.slice(0, at)
  const failing = at === -1 ? undefined : args.slice(at + 1)
  if (failing !== undefined && failing.length === 0) throw new Error('-- needs the failing command after it')
  const { values, positionals } = parseArgs({
    args: own,
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      harness: { type: 'string' },
      model: { type: 'string' },
      dump: { type: 'string' },
      project: { type: 'string' },
      comment: { type: 'string' },
      send: { type: 'boolean', default: false },
    },
  })
  return { values: { ...values, failing }, positionals }
}
