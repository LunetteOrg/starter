// What `lntt validate` checks past the schema, as plain logic: what the schema cannot express
// (src/references.ts), the references between lists and the keys the board skills need. What
// matches the schema and still reads otherwise is a warning, and the file stays valid; a
// delivery.review lntt review refuses is its own error, at its first round.

import { checkMissing, checkReferences } from '../references.ts'
import { reviewConfig, reviewWarnings } from '../review.ts'

export interface Validation {
  // The message of a configuration that does not hold, null when it holds.
  failure: string | null
  warnings: string[]
}

const indent = (lines: string[]) => lines.map((l) => `  ${l}`).join('\n')

export function validation(path: string, data: Record<string, unknown>): Validation {
  const wrong = checkReferences(data)
  const missing = checkMissing(data)
  const parts = [
    ...(wrong.length > 0 ? [`a value names no entry of its list:\n${indent(wrong)}`] : []),
    ...(missing.length > 0 ? [`a key the board skills need is missing:\n${indent(missing)}`] : []),
  ]
  if (parts.length > 0) return { failure: `${path}: ${parts.join('\n')}`, warnings: [] }
  let warnings: string[] = []
  try {
    warnings = reviewWarnings(reviewConfig(data))
  } catch {}
  return { failure: null, warnings }
}
