// The project's configuration read from a real directory, for the end-to-end tests of the schema
// and of the released configurations: the plain logic of src/config/project.ts and src/files.ts
// over node:fs. lntt itself reads it on Effect (src/config/load.ts).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CONFIG_DIR, CONFIG_NAME, editConfig, type Loaded, noConfig, readConfig } from '../src/config/project.ts'
import { ancestors, candidates, type Located, pick } from '../src/files.ts'

// Walks up from `cwd` to the nearest directory holding `.agents/config.*`.
export function findConfig(cwd: string): Located {
  for (const dir of ancestors(cwd, dirname)) {
    const found = pick(candidates(join(dir, CONFIG_DIR), CONFIG_NAME, join).filter((f) => existsSync(f.path)))
    if (found) return found
  }
  throw noConfig(cwd)
}

export function loadConfig(cwd: string): Loaded {
  const located = findConfig(cwd)
  return { ...located, data: readConfig(readFileSync(located.path, 'utf8'), located) }
}

// Sets a dotted key, keeping every comment; a rejected value leaves the file as it was.
export function setValue(cwd: string, key: string, value: unknown): void {
  const located = findConfig(cwd)
  writeFileSync(located.path, editConfig(readFileSync(located.path, 'utf8'), located, key, value))
}
