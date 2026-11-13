// The files a check reads: tracked or new and not ignored, relative to the root, less those of a
// nested project (a folder with a configuration of its own, a template) and of the stubs of the
// shared skills (checked by the skills area), whose own check they are. Listed by Git, read once
// into a Tree (src/check/tree.ts).

import * as Effect from 'effect/Effect'
import { Git } from '../git/git.ts'
import { CheckFailed, synced } from './areas.ts'
import { readTree } from './tree.ts'

// The files of git's listing a check reads, sorted: what is below a nested project or a stub
// folder is left out.
export function keptFiles(listed: string[], stubs: string[]): string[] {
  const nested = [
    ...new Set(
      listed
        .map((f) => /^(.+)\/\.agents\/config\.(?:jsonc|yml)$/.exec(f)?.[1])
        .filter((dir): dir is string => dir !== undefined),
    ),
  ]
  const skip = [...nested, ...stubs]
  return [...new Set(listed)].filter((f) => !skip.some((dir) => f.startsWith(`${dir}/`))).sort()
}

// The project's files as git lists them, before the working tree is looked at.
export const listedFiles = Effect.fnUntraced(function* (root: string) {
  const listed = yield* (yield* Git)
    .listFiles(root)
    .pipe(
      Effect.mapError(
        () => new CheckFailed({ message: `git cannot list the files of ${root}: lntt check reads a git repository` }),
      ),
    )
  return keptFiles(listed, yield* synced((checks) => checks.stubFolders(root)))
})

// The project read: its files, and `also`, the paths a command names besides them.
export const projectTree = Effect.fnUntraced(function* (root: string, also: string[] = []) {
  return yield* readTree(root, yield* listedFiles(root), also)
})
