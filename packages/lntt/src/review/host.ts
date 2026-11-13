// The code of `lntt review status` and `cost`, not yet on Effect, that reaches the machine: the
// project's configuration, and the place of the state store. No Effect at load: src/review-cli.ts
// calls it directly. The place is on Effect (src/review/place.ts): placeFor loads it when called.

import { homedir } from 'node:os'
import { cwd } from 'node:process'
import { findConfig, loadConfig } from '../config/sync.ts'
import { NoConfigError } from '../files.ts'
import type { Place } from './place.ts'

// No configuration file: the defaults. A file that does not validate is an error: a
// review on the defaults would pass for the one the project configured.
export function loaded(): Record<string, unknown> {
  try {
    findConfig(cwd())
  } catch (error) {
    if (error instanceof NoConfigError) return {}
    throw error
  }
  return loadConfig(cwd()).data
}

// Where each branch's state and ledger are kept between runs: one file of each per branch, in the
// place the operator, the project or the clone names (src/review/place.ts), which the first look
// also fills with what this worktree kept in its git directory before the place existed, saying
// so on stderr. It rejects with the failure, its message what to say.
export async function placeFor(): Promise<Place> {
  const { runPlace } = await import('./place.ts')
  return runPlace(homedir())
}
