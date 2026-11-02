// A clone of a local origin as a branch's base sees it: origin/main ahead of the local
// main, which is stale, and an open candidate (origin/candidate/13) one commit ahead of
// origin/main. Shared by the tests of the base resolution (src/base.ts).

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface Clone {
  // The working clone, on main.
  repo: string
  // The commits: the local main (stale), origin/main, origin/candidate/13's head.
  stale: string
  main: string
  candidate: string
  git: (...args: string[]) => string
}

function run(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function commit(cwd: string, files: Record<string, string>, message: string): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), content)
  }
  run(cwd, 'add', '-A')
  run(cwd, 'commit', '-q', '--allow-empty', '-m', message)
  return run(cwd, 'rev-parse', 'HEAD')
}

// In `dir`: origin.git, a seed clone that pushed the history, and `repo`, the clone under
// test. `files` are committed first, in the commit the local main stays on.
export function clone(dir: string, files: Record<string, string> = {}): Clone {
  const origin = join(dir, 'origin.git')
  const seed = join(dir, 'seed')
  const repo = join(dir, 'repo')
  mkdirSync(dir, { recursive: true })
  run(dir, 'init', '-q', '--bare', '-b', 'main', origin)
  run(dir, 'clone', '-q', origin, seed)
  run(seed, 'switch', '-q', '-c', 'main')
  const stale = commit(seed, files, 'base')
  run(seed, 'push', '-q', 'origin', 'main')
  run(dir, 'clone', '-q', origin, repo)
  const main = commit(seed, { 'b.txt': 'on main\n' }, 'main moves on')
  run(seed, 'push', '-q', 'origin', 'main')
  run(seed, 'switch', '-q', '-c', 'candidate/13')
  const candidate = commit(seed, { 'c.txt': 'in the candidate\n' }, 'squashed into the candidate')
  run(seed, 'push', '-q', 'origin', 'candidate/13')
  run(repo, 'fetch', '-q', 'origin')
  return { repo, stale, main, candidate, git: (...args) => run(repo, ...args) }
}
