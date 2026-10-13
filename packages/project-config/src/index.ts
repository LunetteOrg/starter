// Reads, validates and edits a Lunette project's configuration: `.agents/config.jsonc`
// or `.agents/config.yml`. Both formats carry comments, which is why scripts read the
// file through here instead of `jq` or `JSON.parse`, and why writes go through an
// editor that keeps them (jsonc-parser `modify`, the `yaml` Document API).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Ajv, type ErrorObject } from 'ajv'
import jsonc from 'jsonc-parser'
import { isMap, parseDocument } from 'yaml'
import schema from '../schema/config.schema.json' with { type: 'json' }

export type Format = 'jsonc' | 'yaml'

export interface Located {
  path: string
  format: Format
}

export interface Loaded extends Located {
  data: Record<string, unknown>
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

const FILES: Array<[string, Format]> = [
  ['config.jsonc', 'jsonc'],
  ['config.yml', 'yaml'],
]

const validate = new Ajv({ allErrors: true, strict: true }).compile(schema)

// Walks up from `cwd` to the nearest directory holding `.agents/config.*`. Exactly one
// format may be there: two files would be two sources of the same values.
export function findConfig(cwd: string): Located {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const found = FILES.map(([name, format]) => ({ path: join(dir, '.agents', name), format })).filter((f) =>
      existsSync(f.path),
    )
    if (found.length > 1) {
      throw new ConfigError(`both ${found.map((f) => f.path).join(' and ')} exist; keep one`)
    }
    if (found.length === 1) return found[0]
    if (dirname(dir) === dir) {
      throw new ConfigError(`no .agents/config.jsonc or .agents/config.yml in ${cwd} or above`)
    }
  }
}

function parse(text: string, located: Located): unknown {
  if (located.format === 'jsonc') {
    const errors: jsonc.ParseError[] = []
    const data = jsonc.parse(text, errors, { allowTrailingComma: true })
    if (errors.length > 0) {
      const at = errors.map((e) => `${jsonc.printParseErrorCode(e.error)} at offset ${e.offset}`).join(', ')
      throw new ConfigError(`${located.path}: ${at}`)
    }
    return data
  }
  const doc = parseDocument(text)
  if (doc.errors.length > 0) {
    throw new ConfigError(`${located.path}: ${doc.errors.map((e) => e.message).join('; ')}`)
  }
  return doc.toJS()
}

function check(data: unknown, path: string): Record<string, unknown> {
  if (validate(data)) return data as Record<string, unknown>
  const lines = (validate.errors ?? []).map((e: ErrorObject) => {
    const extra =
      e.keyword === 'additionalProperties'
        ? ` (${(e.params as { additionalProperty: string }).additionalProperty})`
        : ''
    return `  ${e.instancePath || '/'} ${e.message}${extra}`
  })
  throw new ConfigError(`${path} does not match the schema:\n${lines.join('\n')}`)
}

export function loadConfig(cwd: string): Loaded {
  const located = findConfig(cwd)
  const data = check(parse(readFileSync(located.path, 'utf8'), located) ?? {}, located.path)
  return { ...located, data }
}

// A dotted key (`recording.logs.adr.path`). A missing key is an error: a script that
// reads `undefined` would go on with a wrong value.
export function getValue(data: unknown, key: string): unknown {
  let value: unknown = data
  const walked: string[] = []
  for (const part of key.split('.')) {
    walked.push(part)
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) {
      throw new ConfigError(`no ${walked.join('.')} in the configuration`)
    }
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

// Sets a dotted key, keeping every comment in the file. The new content is validated
// before it is written, so a rejected value leaves the file as it was.
export function setValue(cwd: string, key: string, value: unknown): void {
  const located = findConfig(cwd)
  const text = readFileSync(located.path, 'utf8')
  const keyPath = key.split('.')
  let next: string
  if (located.format === 'jsonc') {
    const edits = jsonc.modify(text, keyPath, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } })
    next = jsonc.applyEdits(text, edits)
  } else {
    const doc = parseDocument(text)
    if (!isMap(doc.contents) && doc.contents !== null) {
      throw new ConfigError(`${located.path}: the top level is not a map`)
    }
    doc.setIn(keyPath, value)
    next = doc.toString()
  }
  check(parse(next, located), located.path)
  writeFileSync(located.path, next)
}
