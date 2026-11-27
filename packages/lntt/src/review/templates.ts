// The texts a review's prompts are filled from, shipped in lntt's agents/ (src/review.ts fills
// them): the frame common to every lens, each lens's brief, what development changes, the
// verifier's and the reply's. Read through the FileSystem from the package (PackageDir), which a
// spec places in memory.

import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import type { Templates } from '../review.ts'
import { PackageDir } from '../sync/project.ts'

// The frame and what development adds, beside the lenses' briefs in agents/review/.
const FRAME = ['common.md', 'before-production.md']

export const readTemplates = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const agents = path.join(yield* PackageDir, 'agents')
  const read = (...parts: string[]) => fs.readFileString(path.join(agents, ...parts))
  const lenses: Record<string, string> = {}
  for (const name of (yield* fs.readDirectory(path.join(agents, 'review'))).sort()) {
    if (name.endsWith('.md') && !FRAME.includes(name)) lenses[name.slice(0, -3)] = yield* read('review', name)
  }
  return {
    common: yield* read('review', 'common.md'),
    beforeProduction: yield* read('review', 'before-production.md'),
    lenses,
    verify: yield* read('verify.md'),
    reply: yield* read('reply.md'),
  } satisfies Templates
})
