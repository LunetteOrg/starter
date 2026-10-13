#!/usr/bin/env node
// lntt-config — read and edit .agents/config.{jsonc,yml} from scripts.
//
//   lntt-config path               the file in use
//   lntt-config validate           exit 0 when the file matches the schema
//   lntt-config get <key>          the value at a dotted key, as plain JSON
//   lntt-config set <key> <json>   set a dotted key, keeping the comments
//   lntt-config operator           the operator profile, merged, as plain JSON
//   lntt-config operator get <key> one key of it
//   lntt-config operator sources   the files it was read from, in merge order
//   lntt-config agents sync        write the managed block of AGENTS.md
//   lntt-config agents check       exit 1 when the block differs from its source
//   lntt-config local app <name>   an app of local.apps, resolved for this worktree (port, url, commands)
//   lntt-config viewer detect      where the session runs and which viewer shows pages, with why
//   lntt-config viewer open <url>  open it there; exit 3 with the agent call when only the agent can
//
// Exit codes: 0 ok, 1 configuration error, 2 usage error.

import { execFileSync } from 'node:child_process'
import { argv, cwd, env, exit, stderr, stdout } from 'node:process'
import {
  ConfigError,
  checkAgentsBlock,
  chooseViewer,
  commandExists,
  findConfig,
  getValue,
  loadConfig,
  loadOperator,
  localApp,
  openWith,
  setValue,
  syncAgentsBlock,
  type Viewer,
} from '../src/index.ts'

const USAGE =
  'usage: lntt-config path | validate | get <key> | set <key> <json> | operator [get <key> | sources] | agents sync|check | local app <name> | viewer detect|open <url>'

function usage(): never {
  stderr.write(`${USAGE}\n`)
  exit(2)
}

const [command, key, raw] = argv.slice(2)

try {
  switch (command) {
    case 'path':
      stdout.write(`${findConfig(cwd()).path}\n`)
      break
    case 'validate':
      loadConfig(cwd())
      break
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
        stderr.write(`lntt-config: ${raw} is not JSON (a string needs quotes: '"it"')\n`)
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
    case 'agents':
      if (key === 'sync') syncAgentsBlock(cwd())
      else if (key === 'check') {
        if (!checkAgentsBlock(cwd())) {
          stderr.write(
            'lntt-config: the managed block of AGENTS.md is missing or edited; run lntt-config agents sync\n',
          )
          exit(1)
        }
      } else usage()
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
} catch (e) {
  if (!(e instanceof ConfigError)) throw e
  stderr.write(`lntt-config: ${e.message}\n`)
  exit(1)
}
