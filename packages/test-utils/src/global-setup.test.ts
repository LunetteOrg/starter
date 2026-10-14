import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { hasTestDatabase, POSTGRES_IMAGE, WORKSPACE_LABEL } from './db.ts'

/**
 * The globalSetup in a process of its own, run from a throwaway workspace so its
 * container carries a label no other run shares. What a run starts, the same run
 * removes, however it ends: teardown, `process.exit`, SIGTERM (turbo killing a task
 * when a sibling fails), SIGHUP (a closed terminal).
 */
const GLOBAL_SETUP = resolve(__dirname, 'global-setup.ts')
const workspaces: string[] = []

afterAll(() => {
  for (const dir of workspaces) {
    for (const id of containersOf(dir)) execFileSync('docker', ['rm', '--force', id])
    rmSync(dir, { recursive: true, force: true })
  }
})

function workspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-gs-')))
  workspaces.push(dir)
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(
    join(dir, 'run.mjs'),
    `import { setup, teardown } from ${JSON.stringify(GLOBAL_SETUP)}
await setup()
console.log('READY ' + (process.env.TEST_DATABASE_URL ?? ''))
const mode = process.argv[2]
// 'teardown' waits for a line on stdin, so the test can look at the container first.
if (mode === 'teardown') process.stdin.once('data', async () => { await teardown(); console.log('DONE') })
else if (mode === 'exit') process.exit(0)
else setInterval(() => {}, 1000)
`,
  )
  return dir
}

function containersOf(dir: string): string[] {
  const out = execFileSync('docker', ['ps', '-aq', '--filter', `label=${WORKSPACE_LABEL}=${dir}`], { encoding: 'utf8' })
  return out.split('\n').filter(Boolean)
}

/** Runs the globalSetup, waits until it published its server, then hands over. */
function start(dir: string, mode: string, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ['run.mjs', mode], { cwd: dir, env: { ...process.env, ...env } })
  let out = ''
  child.stdout.on('data', (d) => {
    out += d
  })
  child.stderr.on('data', (d) => {
    out += d
  })
  const exited = new Promise<number | null>((done) =>
    child.on('exit', (code, signal) => done(code ?? (signal ? -1 : null))),
  )
  const ready = new Promise<string>((done, fail) => {
    child.stdout.on('data', () => {
      const line = out.split('\n').find((l) => l.startsWith('READY'))
      if (line !== undefined) done(line.slice('READY '.length))
    })
    void exited.then(() => fail(new Error(`exited before READY:\n${out}`)))
  })
  return { child, ready, exited, output: () => out }
}

// The child must not inherit this run's server, or it would start nothing.
const own = { TEST_DATABASE_URL: '' }

describe.skipIf(!hasTestDatabase())('the globalSetup owns one Postgres', () => {
  it('publishes it as TEST_DATABASE_URL, labelled with the workspace, and removes it in teardown', async () => {
    const dir = workspace()
    const run = start(dir, 'teardown', own)
    expect(await run.ready).toMatch(/^postgres(ql)?:\/\//)
    const [id] = containersOf(dir)
    const inspect = (format: string) =>
      execFileSync('docker', ['inspect', '--format', format, id as string], { encoding: 'utf8' }).trim()
    expect(inspect('{{.Config.Image}}')).toBe(POSTGRES_IMAGE)
    // The data directory lives in memory: a test database is never worth a disk write.
    expect(inspect('{{json .HostConfig.Tmpfs}}')).toContain('/var/lib/postgresql/data')
    run.child.stdin.end('teardown\n')
    expect(await run.exited).toBe(0)
    expect(containersOf(dir)).toEqual([])
  })

  it.each(['SIGTERM', 'SIGHUP'] as const)('removes it when the run is killed with %s', async (signal) => {
    const dir = workspace()
    const run = start(dir, 'wait', own)
    await run.ready
    expect(containersOf(dir)).toHaveLength(1)
    run.child.kill(signal)
    await run.exited
    expect(containersOf(dir)).toEqual([])
  })

  it('removes it when the process exits without a teardown', async () => {
    const dir = workspace()
    const run = start(dir, 'exit', own)
    await run.ready
    await run.exited
    expect(containersOf(dir)).toEqual([])
  })

  it('starts nothing when a server is given', async () => {
    const dir = workspace()
    const run = start(dir, 'teardown', { TEST_DATABASE_URL: 'postgresql://given@localhost:1/x' })
    expect(await run.ready).toBe('postgresql://given@localhost:1/x')
    expect(containersOf(dir)).toEqual([])
    run.child.stdin.end('teardown\n')
    expect(await run.exited).toBe(0)
  })
})
