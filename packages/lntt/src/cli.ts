// The commands of `lntt` src/cli.ts dispatches (usage: bin/lntt.ts): each parsed here, a usage
// error exits 2 before Effect loads, then run on Effect by its module.

import { homedir, tmpdir } from 'node:os'
import { cwd, env, platform, stderr, stdout } from 'node:process'
import { parseArgs } from 'node:util'
import type { ConfigCommand } from './config/command.ts'
import { exit } from './exit.ts'
import type { LocalCommand } from './local/command.ts'
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
    const local = localCommand(args)
    if (local !== null) {
      // On Effect (src/local/command.ts), loaded only for these commands.
      const { runLocal } = await import('./local/command.ts')
      return runLocal(local)
    }
    run(command)
  } catch (e) {
    if (e instanceof TypeError && 'code' in e && String(e.code).startsWith('ERR_PARSE_ARGS')) usage(e.message)
    throw e
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

// `lntt local app <name>`, `lntt viewer detect|open <url>` or `lntt browser [<app>] [--json]
// [--query <jq>]` from its arguments, null for any other command: usage, exit 2, before Effect
// loads. What it reads from the session is read here.
function localCommand(args: string[]): LocalCommand | null {
  const [command, key, raw] = args
  if (command !== 'local' && command !== 'viewer' && command !== 'browser') return null
  const session = { cwd: cwd(), home: homedir(), env, platform }
  if (command === 'local') {
    if (key !== 'app' || !raw || args.length > 3) usage()
    return { ...session, kind: 'app', name: raw }
  }
  if (command === 'viewer') {
    if (key === 'detect' && args.length === 2) return { ...session, kind: 'viewer' }
    if (key === 'open' && raw && args.length === 3) return { ...session, kind: 'viewer', open: raw }
    return usage()
  }
  const { values, positionals } = parseArgs({
    args: args.slice(1),
    allowPositionals: true,
    options: { json: { type: 'boolean', default: false }, query: { type: 'string' } },
  })
  if (positionals.length > 1) usage()
  return {
    ...session,
    kind: 'browser',
    json: values.json,
    tmp: tmpdir(),
    ...(positionals[0] === undefined ? {} : { app: positionals[0] }),
    ...(values.query === undefined ? {} : { query: values.query }),
  }
}

function run(command: string | undefined): void {
  switch (command) {
    // Asked for, the usage is the answer: stdout, exit 0 (`npx @lntt/lntt --help`).
    case '--help':
    case '-h':
    case 'help':
      stdout.write(`${USAGE}\n`)
      break
    default:
      usage()
  }
}
