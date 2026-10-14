import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { hasTestDatabase, POSTGRES_IMAGE, WORKSPACE_LABEL } from './db.ts'

/**
 * `lntt-clean-test` removes what a run could not: by the workspace label, never by
 * image, because a development machine runs other projects' Postgres too. Each case
 * labels throwaway containers with throwaway workspaces, so it never touches a run
 * in progress, this one included.
 */
const BIN = resolve(__dirname, 'clean-test.ts')
const created: string[] = []
const dirs: string[] = []

afterAll(() => {
  for (const id of created) spawnSync('docker', ['rm', '--force', id])
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function workspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-clean-')))
  dirs.push(dir)
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n')
  return dir
}

function container(label: string): string {
  const id = execFileSync('docker', ['create', '--label', label, POSTGRES_IMAGE], { encoding: 'utf8' }).trim()
  created.push(id)
  return id
}

function exists(id: string): boolean {
  return spawnSync('docker', ['inspect', id], { stdio: 'ignore' }).status === 0
}

function clean(cwd: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
  return { status: r.status, output: `${r.stdout}${r.stderr}` }
}

describe.skipIf(!hasTestDatabase())('lntt-clean-test', () => {
  it('removes the containers of this workspace only, and never an unlabelled one', () => {
    const [mine, other] = [workspace(), workspace()]
    const ours = container(`${WORKSPACE_LABEL}=${mine}`)
    const theirs = container(`${WORKSPACE_LABEL}=${other}`)
    const foreign = container('com.example.other=1')

    const r = clean(mine)
    expect(r.status, r.output).toBe(0)
    expect(r.output).toContain(mine)
    expect([exists(ours), exists(theirs), exists(foreign)]).toEqual([false, true, true])
  })

  // --all reaches every run on the machine, this one's server included, so it is
  // checked through --dry-run, which lists what it would remove and removes nothing.
  it('with --all reaches every workspace’s, for worktrees that no longer exist', () => {
    const [a, b] = [workspace(), workspace()]
    const first = container(`${WORKSPACE_LABEL}=${a}`)
    const second = container(`${WORKSPACE_LABEL}=${b}`)
    const foreign = container('com.example.other=1')

    const r = clean(a, ['--all', '--dry-run'])
    expect(r.status, r.output).toBe(0)
    expect(r.output).toContain(first.slice(0, 12))
    expect(r.output).toContain(second.slice(0, 12))
    expect(r.output).not.toContain(foreign.slice(0, 12))
    expect([exists(first), exists(second), exists(foreign)]).toEqual([true, true, true])
  })

  it('says so when there is nothing to remove', () => {
    const r = clean(workspace())
    expect(r.status).toBe(0)
    expect(r.output).toMatch(/no test container/)
  })
})

// Without the docker CLI the bin has nothing to ask and exits 0: a different case.
const dockerCli = spawnSync('docker', ['--version'], { stdio: 'ignore' }).status === 0

describe.skipIf(!dockerCli)('lntt-clean-test without a Docker daemon', () => {
  it('fails instead of reporting a clean machine it cannot see', () => {
    const r = clean(workspace(), [], { DOCKER_HOST: 'unix:///nonexistent/docker.sock' })
    expect(r.status).toBe(1)
    expect(r.output).toMatch(/daemon/)
  })
})
