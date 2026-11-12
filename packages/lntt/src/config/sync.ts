// The configuration and the operator profile for the modules not yet on Effect, and for the
// library API of @lntt/lntt (src/index.ts), which stays synchronous: a thin shell over node:fs
// and git around the same plain logic the Effect form uses (src/config/project.ts,
// src/config/operator.ts; the Effect form is src/config/load.ts). It loads no Effect.
//
// Transitional (docs/adr/effect-in-lntt.md#the-bridge-while-modules-move): it goes when the last
// module that calls it moves to Effect, with #341.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ancestors, candidates, type Located, pick } from '../files.ts'
import { mainCheckout, OPERATOR_NAME, type Profile, profileOf, readProfile, slugOf } from './operator.ts'
import { CONFIG_DIR, CONFIG_NAME, editConfig, type Loaded, noConfig, readConfig } from './project.ts'

function locate(dir: string, name: string): Located | undefined {
  return pick(candidates(dir, name, join).filter((f) => existsSync(f.path)))
}

// Walks up from `cwd` to the nearest directory holding `.agents/config.*`.
export function findConfig(cwd: string): Located {
  for (const dir of ancestors(cwd, dirname)) {
    const found = locate(join(dir, CONFIG_DIR), CONFIG_NAME)
    if (found) return found
  }
  throw noConfig(cwd)
}

export function loadConfig(cwd: string): Loaded {
  const located = findConfig(cwd)
  return { ...located, data: readConfig(readFileSync(located.path, 'utf8'), located) }
}

// Sets a dotted key, keeping every comment in the file; a rejected value leaves the file as it was.
export function setValue(cwd: string, key: string, value: unknown): void {
  const located = findConfig(cwd)
  writeFileSync(located.path, editConfig(readFileSync(located.path, 'utf8'), located, key, value))
}

function gitOut(cwd: string, ...args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

function projectProfile(cwd: string, home: string): Located | undefined {
  const common = gitOut(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  if (!common) return undefined
  const main = mainCheckout(common)
  const local = main === undefined ? undefined : locate(join(main, '.agents', 'local'), OPERATOR_NAME)
  if (local) return local
  const repo = slugOf(gitOut(cwd, 'remote', 'get-url', 'origin') ?? '')
  return repo ? locate(join(home, '.agents', 'projects', repo), OPERATOR_NAME) : undefined
}

export function loadOperator(cwd: string, options: { home?: string } = {}): Profile {
  const home = options.home ?? homedir()
  const found = [locate(join(home, '.agents'), OPERATOR_NAME), projectProfile(cwd, home)].filter(
    (l): l is Located => l !== undefined,
  )
  return profileOf(found.map((l) => ({ path: l.path, profile: readProfile(readFileSync(l.path, 'utf8'), l) })))
}
