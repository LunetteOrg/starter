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
//
// Exit codes: 0 ok, 1 configuration error, 2 usage error.

import { argv, cwd, exit, stderr, stdout } from 'node:process'
import { ConfigError, findConfig, getValue, loadConfig, loadOperator, setValue } from '../src/index.ts'

const USAGE = 'usage: lntt-config path | validate | get <key> | set <key> <json> | operator [get <key> | sources]'

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
    default:
      usage()
  }
} catch (e) {
  if (!(e instanceof ConfigError)) throw e
  stderr.write(`lntt-config: ${e.message}\n`)
  exit(1)
}
