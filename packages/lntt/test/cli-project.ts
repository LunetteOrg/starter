// A throwaway Lunette project in which every command that takes --json has something to print,
// as long as asked: a file with a long line (lntt check cite), an app with a long URL (lntt
// browser), a review state with many rounds (lntt review cost and status). Shared by the tests
// of the exit path and of --query.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { branchKey } from '../src/review-store.ts'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/lntt.ts')
export const BRANCH = 'feat/1/x'

export type Project = { root: string; rounds: number; remove: () => void }

// `long`: the length of the line of long.txt and of the app's URL path; the rounds are as many
// as make a cost document of about that length.
export function project({ long = 10, rounds = Math.max(1, Math.ceil(long / 90)) } = {}): Project {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-cli-')))
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'ignore' })
  mkdirSync(join(root, '.agents'))
  writeFileSync(
    join(root, '.agents/config.jsonc'),
    JSON.stringify({
      local: {
        apps: {
          web: {
            port: 5173,
            url: `http://localhost:{port}/${'u'.repeat(long)}`,
            commands: { start: { run: 'pnpm dev' } },
          },
        },
      },
      delivery: {
        review: {
          reviewers: {
            decisions: { with: [] },
            tests: { with: [] },
            code: { with: [{ kind: 'claude', model: 'sonnet' }] },
          },
          verify: { with: [{ kind: 'claude', model: 'opus' }] },
        },
      },
    }),
  )
  writeFileSync(join(root, 'package.json'), '{"name":"app"}\n')
  writeFileSync(join(root, 'long.txt'), `${'x'.repeat(long)}\nshort "line"\n`)
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-qm', 'init')
  git('switch', '-qc', BRANCH)
  const state = join(root, '.git/lntt-review/state', `${branchKey(BRANCH)}.json`)
  mkdirSync(dirname(state), { recursive: true })
  const cost = (round: number) => ({ round, head: 'h', tokens: 1, usd: 0.5, noTokens: [], noUsd: [] })
  writeFileSync(
    state,
    JSON.stringify({
      branch: BRANCH,
      round: rounds,
      reviewed: 'abc',
      result: {
        round: rounds,
        base: 'b',
        head: 'h',
        scope: 'first round',
        lenses: ['code'],
        findings: [],
        refuted: [],
        failed: [],
        partial: [],
        skipped: [],
        closed: [],
        blocking: ['blocker', 'warning'],
        cost: 0.5,
        tokens: 1,
        noTokens: [],
        noUsd: [],
      },
      rounds: Array.from({ length: rounds }, (_, i) => cost(i + 1)),
    }),
  )
  return { root, rounds, remove: () => rmSync(root, { recursive: true, force: true }) }
}

// lntt in the project, its stdout and stderr each through a pipe; git never looks above it.
export function cli(p: Project, args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: p.root,
    encoding: 'utf8',
    maxBuffer: 1e8,
    timeout: 60_000,
    env: { PATH: process.env.PATH, HOME: p.root, GIT_CEILING_DIRECTORIES: dirname(p.root) },
  })
}
