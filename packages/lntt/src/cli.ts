// The configuration commands of `lntt` (usage: bin/lntt.ts).

import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { cwd, env, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import type { ConfigCommand } from './config/command.ts'
import { exit, printed } from './exit.ts'
import {
  browserApp,
  browserPlan,
  ConfigError,
  chooseDriver,
  chooseViewer,
  commandExists,
  type Driver,
  formatPlan,
  loadOperator,
  localApp,
  openWith,
  type Viewer,
} from './index.ts'
import { runQuery } from './query.ts'
import type { SyncCommand } from './sync/command.ts'

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
    const config = configCommand(command, key, raw)
    if (config !== null) {
      // On Effect (src/config/command.ts), loaded only for these commands.
      const { runConfig } = await import('./config/command.ts')
      return runConfig(config, cwd(), homedir())
    }
    const sync = syncCommand(command, key, args.length)
    if (sync !== null) {
      // On Effect (src/sync/command.ts), loaded only for these commands.
      const { runSync } = await import('./sync/command.ts')
      return runSync(sync)
    }
    if (command === 'browser') await browser(args.slice(1))
    else run(command, key, raw)
  } catch (e) {
    if (e instanceof TypeError && 'code' in e && String(e.code).startsWith('ERR_PARSE_ARGS')) usage(e.message)
    if (!(e instanceof ConfigError)) throw e
    stderr.write(`lntt: ${e.message}\n`)
    exit(1)
  }
}

// A configuration command from its arguments, null for any other: usage, exit 2, before Effect
// loads.
function configCommand(
  command: string | undefined,
  key: string | undefined,
  raw: string | undefined,
): ConfigCommand | null {
  switch (command) {
    case 'path':
      return { kind: 'path' }
    case 'validate':
      return { kind: 'validate' }
    case 'get':
      if (!key) usage()
      return { kind: 'get', key }
    case 'set': {
      if (!key || raw === undefined) usage()
      try {
        return { kind: 'set', key, value: JSON.parse(raw) }
      } catch {
        stderr.write(`lntt: ${raw} is not JSON (a string needs quotes: '"it"')\n`)
        return exit(2)
      }
    }
    case 'operator':
      if (key === undefined) return { kind: 'operator', show: 'profile' }
      if (key === 'sources') return { kind: 'operator', show: 'sources' }
      if (key === 'get' && raw) return { kind: 'operator', show: { key: raw } }
      return usage()
    default:
      return null
  }
}

// `lntt sync` or `lntt guide [<skill>]` from its arguments, null for any other command: usage,
// exit 2, before Effect loads.
function syncCommand(command: string | undefined, key: string | undefined, count: number): SyncCommand | null {
  if (command === 'sync') return count === 1 ? { kind: 'sync', cwd: cwd() } : usage()
  if (command === 'guide') {
    if (count > 2) usage()
    return key === undefined ? { kind: 'guide' } : { kind: 'guide', name: key }
  }
  return null
}

function run(command: string | undefined, key: string | undefined, raw: string | undefined): void {
  switch (command) {
    // Asked for, the usage is the answer: stdout, exit 0 (`npx @lntt/lntt --help`).
    case '--help':
    case '-h':
    case 'help':
      stdout.write(`${USAGE}\n`)
      break
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
