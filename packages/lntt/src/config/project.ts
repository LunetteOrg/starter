// A Lunette project's configuration as plain logic: `.agents/config.jsonc` or
// `.agents/config.yml`, read from its text, validated against the schema, and edited keeping
// its comments (jsonc-parser `modify`, the `yaml` Document API). Both formats carry comments,
// which is why scripts read the file through lntt instead of `jq` or `JSON.parse`. No file
// system here: src/config/load.ts reads and writes the file on Effect, src/config/sync.ts for
// the modules not yet on it.

import { Ajv } from 'ajv'
import jsonc from 'jsonc-parser'
import { isMap, parseDocument } from 'yaml'
import schema from '../../schema/config.schema.json' with { type: 'json' }
import { ConfigError, check, type Located, NoConfigError, parse } from '../files.ts'
import type { Phase } from '../review.ts'

export interface Loaded extends Located {
  data: Record<string, unknown>
}

const validate = new Ajv({ allErrors: true, strict: true }).compile(schema)

// Where the configuration is looked for, in each directory from the working one up.
export const CONFIG_DIR = '.agents'
export const CONFIG_NAME = 'config'

export const noConfig = (cwd: string): NoConfigError =>
  new NoConfigError(`no .agents/config.jsonc or .agents/config.yml in ${cwd} or above`)

// The configuration in `text`, validated: an empty file is an empty configuration.
export function readConfig(text: string, located: Located): Record<string, unknown> {
  return check(validate, parse(text, located) ?? {}, located.path)
}

// The text with a dotted key set to `value`, every comment kept. The new content is validated
// before it is returned, so a rejected value leaves nothing to write.
export function editConfig(text: string, located: Located, key: string, value: unknown): string {
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
  check(validate, parse(next, located), located.path)
  return next
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

// Where the project stands. A missing key is the schema's default, production: a project
// keeps every check until its team says otherwise. The only key lntt get reads a default
// for: every other missing key is an error.
export function projectPhase(data: Record<string, unknown>): Phase {
  const project = data.project as { phase?: Phase } | undefined
  return project?.phase ?? (schema.properties.project.properties.phase.default as Phase)
}

export function getConfigValue(data: Record<string, unknown>, key: string): unknown {
  return key === 'project.phase' ? projectPhase(data) : getValue(data, key)
}
