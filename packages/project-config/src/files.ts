// The two formats a Lunette file can take, parsed and validated the same way:
// `<name>.jsonc` or `<name>.yml`, one of the two in a directory.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ErrorObject, ValidateFunction } from 'ajv'
import jsonc from 'jsonc-parser'
import { parseDocument } from 'yaml'

export type Format = 'jsonc' | 'yaml'

export interface Located {
  path: string
  format: Format
}

export class ConfigError extends Error {
  override name = 'ConfigError'
}

// `<dir>/<name>.jsonc` or `<dir>/<name>.yml`; both at once would be two sources of
// the same values, so it is an error.
export function locate(dir: string, name: string): Located | undefined {
  const found = (
    [
      [`${name}.jsonc`, 'jsonc'],
      [`${name}.yml`, 'yaml'],
    ] as const
  )
    .map(([file, format]) => ({ path: join(dir, file), format }))
    .filter((f) => existsSync(f.path))
  if (found.length > 1) {
    throw new ConfigError(`both ${found.map((f) => f.path).join(' and ')} exist; keep one`)
  }
  return found[0]
}

export function parse(text: string, located: Located): unknown {
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

export function check(validate: ValidateFunction, data: unknown, path: string): Record<string, unknown> {
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
