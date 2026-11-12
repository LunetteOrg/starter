// The configuration commands of `lntt` (usage: bin/lntt.ts).

import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { cwd, env, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import { syncAutomated } from './automated.ts'
import { exit, printed } from './exit.ts'
import {
  browserApp,
  browserPlan,
  ConfigError,
  chooseDriver,
  chooseViewer,
  commandExists,
  type Driver,
  findConfig,
  formatPlan,
  getConfigValue,
  getValue,
  guide,
  loadConfig,
  loadOperator,
  localApp,
  openWith,
  setValue,
  sharedSkills,
  syncAgentsBlock,
  syncClaudeSettings,
  syncSkills,
  type Viewer,
} from './index.ts'
import { runQuery } from './query.ts'
import { checkMissing, checkReferences } from './references.ts'
import { reviewConfig, reviewWarnings } from './review.ts'

const USAGE = [
  'usage: lntt path | validate | get <key> | set <key> <json> | operator [get <key> | sources]',
  '       lntt sync | guide [<skill>] | local app <name> | viewer detect|open <url> | browser [<app>] [--json] [--query <jq>]',
  '       lntt check [<area> [<check>]] [--base <ref>] [--json] [--query <jq>] | check cite <path:line>...',
  '       lntt refs [--cached] [<text>...]',
  '       lntt board sync [--apply | --check] | board ready [--apply]',
  '       lntt branch name|check|rename [...]',
  '       lntt worktree start --issue <n> [...]',
  '       lntt ci local|candidate [...]',
].join('\n')

function usage(message?: string): never {
  if (message) stderr.write(`lntt: ${message}\n`)
  stderr.write(`${USAGE}\n`)
  exit(2)
}

// `lntt <command> [...]`, every command but `ci` (./ci/cli.ts).
export async function main(args: string[]): Promise<void> {
  const [command, key, raw] = args
  try {
    if (command === 'browser') await browser(args.slice(1))
    else run(command, key, raw)
  } catch (e) {
    if (e instanceof TypeError && 'code' in e && String(e.code).startsWith('ERR_PARSE_ARGS')) usage(e.message)
    if (!(e instanceof ConfigError)) throw e
    stderr.write(`lntt: ${e.message}\n`)
    exit(1)
  }
}

function run(command: string | undefined, key: string | undefined, raw: string | undefined): void {
  switch (command) {
    // Asked for, the usage is the answer: stdout, exit 0 (`npx @lntt/lntt --help`).
    case '--help':
    case '-h':
    case 'help':
      stdout.write(`${USAGE}\n`)
      break
    case 'path':
      stdout.write(`${findConfig(cwd()).path}\n`)
      break
    case 'validate': {
      // The schema on load, then what it cannot express (./references.ts): the
      // references between lists, and the keys the board skills need.
      const { path, data } = loadConfig(cwd())
      const indent = (lines: string[]) => lines.map((l) => `  ${l}`).join('\n')
      const wrong = checkReferences(data)
      const missing = checkMissing(data)
      const parts = [
        ...(wrong.length > 0 ? [`a value names no entry of its list:\n${indent(wrong)}`] : []),
        ...(missing.length > 0 ? [`a key the board skills need is missing:\n${indent(missing)}`] : []),
      ]
      if (parts.length > 0) throw new ConfigError(`${path}: ${parts.join('\n')}`)
      // What matches the schema and still reads otherwise: said, the file stays valid.
      // A delivery.review lntt review refuses is its own error, at its first round.
      let warnings: string[] = []
      try {
        warnings = reviewWarnings(reviewConfig(data))
      } catch {}
      for (const warning of warnings) stderr.write(`lntt validate: warning: ${warning}\n`)
      break
    }
    case 'get':
      if (!key) usage()
      stdout.write(`${JSON.stringify(getConfigValue(loadConfig(cwd()).data, key))}\n`)
      break
    case 'set': {
      if (!key || raw === undefined) usage()
      let value: unknown
      try {
        value = JSON.parse(raw)
      } catch {
        stderr.write(`lntt: ${raw} is not JSON (a string needs quotes: '"it"')\n`)
        exit(2)
      }
      setValue(cwd(), key, value)
      break
    }
    case 'operator': {
      const { profile, sources } = loadOperator(cwd())
      if (key === undefined) stdout.write(`${JSON.stringify(profile)}\n`)
      else if (key === 'sources') stdout.write(sources.map((s) => `${s}\n`).join(''))
      else if (key === 'get' && raw) stdout.write(`${JSON.stringify(getValue(profile, raw))}\n`)
      else usage()
      break
    }
    case 'sync':
      // The skills first: a clash with a project skill stops the command before any write.
      syncSkills(cwd())
      syncAgentsBlock(cwd())
      syncClaudeSettings(cwd())
      syncAutomated(dirname(dirname(findConfig(cwd()).path)))
      break
    case 'guide': {
      if (key === undefined) {
        stdout.write(
          sharedSkills()
            .map((s) => `${s}\n`)
            .join(''),
        )
        break
      }
      const text = guide(key)
      if (text === null) {
        stderr.write(`lntt guide: no skill ${key}; the skills are ${sharedSkills().join(', ')}\n`)
        exit(1)
      }
      stdout.write(text)
      break
    }
    case 'local':
      if (key !== 'app' || !raw) usage()
      stdout.write(`${JSON.stringify(localApp(cwd(), raw))}\n`)
      break
    case 'viewer': {
      const preferences = ((loadOperator(cwd()).profile.workspace as { viewers?: Viewer[] } | undefined)?.viewers ??
        []) as Viewer[]
      const choice = chooseViewer({ env, preferences, has: commandExists })
      if (key === 'detect') stdout.write(`${JSON.stringify(choice)}\n`)
      else if (key === 'open' && raw) {
        const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
        if (!openWith(choice, raw, root)) {
          stdout.write(
            `${JSON.stringify({ viewer: choice.viewer, ...(choice.agentCall ? { call: choice.agentCall } : {}), url: raw })}\n`,
          )
          exit(3)
        }
      } else usage()
      break
    }
    default:
      usage()
  }
}

// `lntt browser [<app>] [--json] [--query <jq>]`: how an agent drives a browser on the app.
async function browser(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { json: { type: 'boolean', default: false }, query: { type: 'string' } },
  })
  if (positionals.length > 1) usage()
  const preferences = ((loadOperator(cwd()).profile.workspace as { browsers?: Driver[] } | undefined)?.browsers ??
    []) as Driver[]
  const app = localApp(cwd(), browserApp(cwd(), positionals[0]))
  const worktree = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const plan = browserPlan({
    app,
    choice: chooseDriver({ env, preferences, has: commandExists }),
    worktree,
    tmp: tmpdir(),
  })
  if (values.query !== undefined) {
    const input = JSON.stringify(plan)
    exit(
      printed(await runQuery({ input, expression: values.query, json: values.json, code: 0, command: 'lntt browser' })),
    )
  }
  stdout.write(values.json ? `${JSON.stringify(plan)}\n` : formatPlan(plan))
}
