// A path matched against a glob of the configuration, as node:path's matchesGlob does it (a
// wildcard skips a name that starts with a dot), with Effect's Glob, which reaches nothing. Each
// pattern is compiled once.

import * as Glob from 'effect/Glob'

const compiled = new Map<string, Glob.Glob>()

export function matchesGlob(path: string, pattern: string): boolean {
  let glob = compiled.get(pattern)
  if (glob === undefined) {
    glob = Glob.make(pattern)
    compiled.set(pattern, glob)
  }
  return Glob.match(glob, path)
}
