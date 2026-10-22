import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { hasTestDatabase, WORKSPACE_LABEL } from './db.ts'
import { E2E_PORT_RANGE, e2ePort } from './e2e-port.ts'

/**
 * Two checkouts of one project (two git worktrees) run their suites at the same
 * time. Each gets its own Postgres, so the same `databaseName` and the same
 * migration name never meet: a shared server would let the second run find the
 * first one's `__drizzle_migrations` and skip its own migration.
 *
 * The workspaces consume the package by name, built to dist/ as published.
 */
const PKG = resolve(__dirname, '..')
const require = createRequire(import.meta.url)
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function link(dir: string, name: string, target: string): void {
  mkdirSync(dirname(join(dir, 'node_modules', name)), { recursive: true })
  symlinkSync(target, join(dir, 'node_modules', name), 'dir')
}

function checkout(mark: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `lntt-ws-${mark}-`)))
  dirs.push(dir)
  link(dir, '@lntt/test-utils', PKG)
  link(dir, 'vitest', dirname(require.resolve('vitest/package.json')))
  const files: Record<string, string> = {
    'pnpm-workspace.yaml': 'packages: []\n',
    'vitest.config.mjs':
      "import { testDbPlugin } from '@lntt/test-utils/plugin'\n" +
      'export default { plugins: [testDbPlugin()], test: { testTimeout: 60000, hookTimeout: 120000 } }\n',
    // The same migration name in both checkouts, creating a different table.
    'drizzle/20260101000000_init/migration.sql': `CREATE TABLE mark_${mark} (id integer);\n`,
    'probe.test.mjs': `import { writeFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'
import { createTestDb } from '@lntt/test-utils'
import { expect, it } from 'vitest'

it('sees its own schema only', async () => {
  writeFileSync('server.txt', process.env.TEST_DATABASE_URL ?? '')
  const db = createTestDb({ databaseName: 'app', migrationsFolder: './drizzle' })
  await db.withTestDb(async (tx) => {
    await setTimeout(1500)
    const rows = await tx.execute("SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'mark_%'")
    expect(rows.map((r) => r.table_name)).toEqual(['mark_${mark}'])
  })
})
`,
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

describe.skipIf(!hasTestDatabase())('two checkouts at once', () => {
  it('run on two servers without touching each other’s databases, and leave no container', async () => {
    const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
    const [a, b] = [checkout('a'), checkout('b')]
    // Each run starts its own server: it must not inherit this run's.
    const env = { ...process.env, TEST_DATABASE_URL: '' }
    const run = (cwd: string) => promisify(execFile)(process.execPath, [vitest, 'run'], { cwd, env })
    await Promise.all([run(a), run(b)])

    const servers = [a, b].map((dir) => readFileSync(join(dir, 'server.txt'), 'utf8'))
    expect(servers[0]).not.toBe('')
    expect(new URL(servers[0] as string).port).not.toBe(new URL(servers[1] as string).port)

    for (const dir of [a, b]) {
      const left = execFileSync('docker', ['ps', '-aq', '--filter', `label=${WORKSPACE_LABEL}=${dir}`], {
        encoding: 'utf8',
      })
      expect(left.trim(), `containers left by ${dir}`).toBe('')
    }
  })
})

// A playwright.config.ts and an e2e import these subpaths by name: Node loads them from
// dist/ as published, with no vitest in between. Needs no database, so it runs without
// one; like the suites above it needs dist/, which the package's `test` script builds.
describe('the Playwright subpaths', () => {
  it('load by name from the built package', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-ws-playwright-')))
    dirs.push(dir)
    link(dir, '@lntt/test-utils', PKG)
    writeFileSync(
      join(dir, 'probe.mjs'),
      "import { e2ePort } from '@lntt/test-utils/e2e-port'\n" +
        "import { ATTEMPT, HYDRATION_DELAY_MS, test } from '@lntt/test-utils/playwright'\n" +
        "const port = e2ePort({ root: process.cwd(), app: 'web', env: {} })\n" +
        'console.log(JSON.stringify({ port, attempt: ATTEMPT.timeout, delay: HYDRATION_DELAY_MS, test: typeof test }))\n',
    )
    const out = JSON.parse(
      execFileSync(process.execPath, ['probe.mjs'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, E2E_HYDRATION_DELAY_MS: '' },
      }),
    )
    expect(out).toMatchObject({ attempt: 1000, delay: 0, test: 'function' })
    expect(out.port).toBe(e2ePort({ root: dir, app: 'web', env: {} }))
    expect(out.port).toBeGreaterThanOrEqual(E2E_PORT_RANGE.min)
    expect(out.port).toBeLessThanOrEqual(E2E_PORT_RANGE.max)
  })
})
