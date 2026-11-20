// lntt's own prompt texts (agents/), for the specs of a review: as the Templates a round fills, and
// as files under a package directory of an in-memory FileSystem, for a command that reads them
// (src/review/templates.ts). Not published: tsconfig.build.json leaves src/testing/ out.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Templates } from '../review.ts'

const AGENTS = fileURLToPath(new URL('../../agents/', import.meta.url))
const read = (...parts: string[]) => readFileSync(join(AGENTS, ...parts), 'utf8')

const LENSES = readdirSync(join(AGENTS, 'review')).filter(
  (name) => name.endsWith('.md') && name !== 'common.md' && name !== 'before-production.md',
)

export const TEMPLATES: Templates = {
  common: read('review', 'common.md'),
  beforeProduction: read('review', 'before-production.md'),
  lenses: Object.fromEntries(LENSES.map((name) => [name.slice(0, -3), read('review', name)])),
  verify: read('verify.md'),
  reply: read('reply.md'),
}

// The prompt texts as files under `pkg`, by absolute path.
export function templateFiles(pkg: string): Record<string, string> {
  return {
    [`${pkg}/agents/review/common.md`]: TEMPLATES.common,
    [`${pkg}/agents/review/before-production.md`]: TEMPLATES.beforeProduction,
    ...Object.fromEntries(
      Object.entries(TEMPLATES.lenses).map(([lens, text]) => [`${pkg}/agents/review/${lens}.md`, text]),
    ),
    [`${pkg}/agents/verify.md`]: TEMPLATES.verify,
    [`${pkg}/agents/reply.md`]: TEMPLATES.reply,
  }
}
