// The configuration commands of `lntt` (usage: bin/lntt.ts).

import { execFileSync } from 'node:child_process'
import { cwd, env, exit, stderr, stdout } from 'node:process'
import {
  ConfigError,
  chooseViewer,
  commandExists,
  findConfig,
  getValue,
  guide,
  loadConfig,
  loadOperator,
  localApp,
  openWith,
  setValue,
  sharedSkills,
  syncAgentsBlock,
  syncSkills,
  type Viewer,
} from './index.ts'
import { checkReferences } from './references.ts'

const USAGE = [
  'usage: lntt path | validate | get <key> | set <key> <json> | operator [get <key> | sources]',
  '       lntt sync | guide [<skill>] | local app <name> | viewer detect|open <url>',
  '       lntt check [<area> [<check>]] [--base <ref>] [--json] | check cite <path:line>...',
  '       lntt branch name|check|rename [...]',
  '       lntt worktree start --issue <n> [...]',
  '       lntt ci local|candidate [...]',
].join('\n')

function usage(): never {
  stderr.write(`${USAGE}\n`)
  exit(2)
}

// `lntt <command> [...]`, every command but `ci` (./ci/cli.ts).
export function main(args: string[]): void {
  const [command, key, raw] = args
  try {
    run(command, key, raw)
  } catch (e) {
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
      // The schema on load, then the references it cannot express (./references.ts).
      const { path, data } = loadConfig(cwd())
      const wrong = checkReferences(data)
      if (wrong.length > 0) {
        throw new ConfigError(`${path}: a value names no entry of its list:\n${wrong.map((l) => `  ${l}`).join('\n')}`)
      }
      break
    }
    case 'get':
      if (!key) usage()
      stdout.write(`${JSON.stringify(getValue(loadConfig(cwd()).data, key))}\n`)
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
