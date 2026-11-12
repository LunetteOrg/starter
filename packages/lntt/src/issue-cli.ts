// `lntt dump` and `lntt issue`: a report on Lunette itself, its environment collected and
// redacted, filed on the Lunette repository once the operator has read it (usage:
// bin/lntt.ts). `lntt issue` runs on Effect (src/issue/command.ts): this module parses its
// arguments, exit 2 before Effect loads, and reads a draft given on stdin. `lntt dump` runs here
// until its module moves to Effect (#341).

import { dirname } from 'node:path'
import { cwd, env, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import { collectDump, redactionFor, renderDump, runFailing } from './dump.ts'
import { Exit, exit, printed } from './exit.ts'
import { findConfig, NoConfigError } from './index.ts'
import type { IssueBridgeService, IssueCommand } from './issue/command.ts'
import { REPOSITORY } from './issue.ts'
import { runQuery } from './query.ts'
import { readStdin } from './stdin.ts'

const USAGE = [
  'usage: lntt dump [--json] [--query <jq>] [--harness <name>] [--model <id>] [-- <failing command>...]',
  '       lntt issue <draft.md | -> [--repo <owner/name>] [--dump <dump.json>] [--harness <name>] [--model <id>]',
  '                  [--project <name>] [--comment <n>] [--send]',
  '       lntt issue search [--repo <owner/name>] <words>...',
].join('\n')

function usage(message?: string): never {
  if (message) stderr.write(`lntt: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

export async function main(command: 'dump' | 'issue', args: string[]): Promise<void> {
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(args)
  } catch (error) {
    usage((error as Error).message)
  }
  if (command === 'issue') {
    let report: IssueCommand
    try {
      report = await issue(parsed)
    } catch (error) {
      if (error instanceof Exit || !(error instanceof Error)) throw error
      // A draft on stdin that cannot be read: one line, no stack.
      stderr.write(`lntt issue: ${error.message}\n`)
      exit(1)
    }
    const { runIssue } = await import('./issue/command.ts')
    return runIssue(report)
  }
  try {
    await dump(parsed)
  } catch (error) {
    if (error instanceof Exit) throw error
    // A refusal, a configuration error or a failed gh: one line, no stack.
    if (!(error instanceof Error)) throw error
    stderr.write(`lntt dump: ${error.message}\n`)
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

async function dump({ values, positionals }: Parsed): Promise<void> {
  const root = projectRoot()
  const failing = values.failing
  if (failing === undefined && positionals.length > 0) usage('the failing command goes after --')
  for (const flag of ['repo', 'dump', 'project', 'comment', 'send'] as const) {
    if (values[flag] !== undefined && values[flag] !== false) usage(`--${flag} is an option of lntt issue`)
  }
  const result = collectDump({
    root,
    env,
    ...(values.harness === undefined ? {} : { harness: values.harness }),
    ...(values.model === undefined ? {} : { model: values.model }),
    ...(failing === undefined ? {} : { command: runFailing(failing, cwd()) }),
  })
  if (values.query !== undefined) {
    const input = JSON.stringify(result)
    const code = result.configError === undefined ? 0 : 1
    const ran = printed(
      await runQuery({ input, expression: values.query, json: values.json, code, command: 'lntt dump' }),
    )
    if (ran !== code) exit(ran)
  } else stdout.write(values.json ? `${JSON.stringify(result)}\n` : renderDump(result))
  // Printed whole, then red: a configuration that does not validate is an error.
  if (result.configError !== undefined) throw new Error(result.configError)
}

// The command lntt issue runs: usage, exit 2, before Effect loads; a draft on stdin read here.
async function issue({ values, positionals }: Parsed): Promise<IssueCommand> {
  if (values.failing !== undefined) usage('lntt issue takes no command after --: lntt dump does')
  if (values.json) usage('--json is an option of lntt dump')
  if (values.query !== undefined) usage('--query is an option of lntt dump')
  if (values.repo !== undefined && !REPOSITORY.test(values.repo)) usage(`--repo takes owner/name, not ${values.repo}`)
  const repo = values.repo === undefined ? {} : { repo: values.repo }
  const [first, ...rest] = positionals
  if (first === 'search') {
    if (rest.length === 0) usage('search needs the words to look for')
    for (const flag of ['dump', 'project', 'comment', 'harness', 'model'] as const) {
      if (values[flag] !== undefined) usage(`search takes no --${flag}`)
    }
    if (values.send) usage('search takes no --send')
    return { kind: 'search', words: rest.join(' '), ...repo, env, cwd: cwd() }
  }
  if (first === undefined || rest.length > 0) usage('issue takes one draft: a file, or - for stdin')
  if (values.comment !== undefined && !/^[1-9]\d*$/.test(values.comment)) {
    usage(`--comment takes an issue number, not ${values.comment}`)
  }
  return {
    kind: 'file',
    draft: first === '-' ? { text: await readStdin() } : { path: first },
    ...repo,
    ...(values.dump === undefined ? {} : { dump: values.dump }),
    ...(values.harness === undefined ? {} : { harness: values.harness }),
    ...(values.model === undefined ? {} : { model: values.model }),
    ...(values.project === undefined ? {} : { project: values.project }),
    ...(values.comment === undefined ? {} : { comment: Number(values.comment) }),
    send: values.send,
    env,
    cwd: cwd(),
  }
}

// What lntt issue reads with the code not yet on Effect (its IssueBridge).
export const issueBridge: IssueBridgeService = {
  collect: (input) => collectDump(input),
  redaction: (root, environment) => redactionFor(root, environment),
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
      query: { type: 'string' },
      repo: { type: 'string' },
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
