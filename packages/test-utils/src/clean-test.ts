#!/usr/bin/env node
// lntt-clean-test [--all] [--dry-run]
//
// Removes the test Postgres containers a run could not: one killed with SIGKILL, or
// during its startup. By LABEL, never by image: a development machine runs other
// projects' Postgres too. By default only this workspace's (a worktree is a workspace
// of its own); `--all` widens to every workspace, for worktrees that no longer exist.
// `--dry-run` lists and removes nothing.
import { execFileSync } from 'node:child_process'
import { WORKSPACE_LABEL, workspaceRoot } from './workspace.ts'

const args = new Set(process.argv.slice(2))
const docker = (argv: string[]): string => execFileSync('docker', argv, { encoding: 'utf8', stdio: 'pipe' })

try {
  docker(['--version'])
} catch {
  console.log('docker not found: nothing to clean up')
  process.exit(0)
}

// The binary is not the daemon: with the daemon down `docker ps` fails, and an empty
// answer would read as a clean machine while the containers are merely invisible.
try {
  docker(['info'])
} catch {
  console.error('the docker daemon is not responding: cannot tell what is left. Start it and run again.')
  process.exit(1)
}

const all = args.has('--all')
const scope = all ? 'every workspace' : workspaceRoot()
const filter = all ? `label=${WORKSPACE_LABEL}` : `label=${WORKSPACE_LABEL}=${scope}`
const ids = docker(['ps', '-aq', '--filter', filter]).split('\n').filter(Boolean)

if (ids.length === 0) {
  console.log(`no test container to remove (${scope})`)
} else if (args.has('--dry-run')) {
  console.log(`would remove ${ids.length} test container(s) (${scope}):\n${ids.join('\n')}`)
} else {
  docker(['rm', '--force', ...ids])
  console.log(`removed ${ids.length} test container(s) (${scope})`)
}
