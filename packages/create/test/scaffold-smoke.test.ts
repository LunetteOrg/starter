import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/index.ts')
const PACKAGES = resolve(dirname(BIN), '../..')

// A scaffolded project must be green on its OWN toolchain, not merely
// structurally correct. This installs a generated project and runs its lint +
// typecheck, so a template-tooling regression — a malformed grit plugin, a broken
// Biome override, a type error in a shipped package, an `@starter` reference a
// rename misses — fails HERE rather than only in a scaffolded project's CI after
// push (the exact class the residue/structure checks don't cover).
//
// Installing the full template takes minutes, so it is gated behind
// SCAFFOLD_SMOKE=1 (set by CI) to keep the default `pnpm test` fast for local runs.
const skip = process.env.SCAFFOLD_SMOKE ? false : 'set SCAFFOLD_SMOKE=1 to run (installs the full template)'

// Any non-zero exit throws → the test fails with the tool's own output.
const run = (cmd: string, args: string[], cwd: string): void => void execFileSync(cmd, args, { cwd, stdio: 'inherit' })

let root: string
let app: string

before(() => {
  if (skip) return
  root = mkdtempSync(join(tmpdir(), 'lntt-smoke-'))
  app = join(root, 'smoke-app')
  run('node', [BIN, 'smoke-app', '--template', 'react-router'], root)
  // `--ignore-scripts`: skip lifecycle scripts (lefthook install, only-allow) —
  // hermetic and faster; lint/typecheck need none of them.
  run('pnpm', ['install', '--no-frozen-lockfile', '--ignore-scripts'], app)
})

after(() => {
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('scaffolded project installs, lints and typechecks clean', { skip }, () => {
  run('pnpm', ['lint'], app)
  run('pnpm', ['typecheck'], app)
})

// Every package this repo publishes besides the CLI: not private, under packages/.
function publishedPackages(): { name: string; dir: string }[] {
  return readdirSync(PACKAGES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(PACKAGES, entry.name))
    .filter((dir) => existsSync(join(dir, 'package.json')))
    .map((dir) => ({ dir, manifest: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) }))
    .filter(({ manifest }) => manifest.private !== true && manifest.name !== '@lntt/create')
    .map(({ dir, manifest }) => ({ name: manifest.name as string, dir }))
}

// Rewrites every file under `dir` (node_modules aside) whose name matches `file`;
// returns how many files changed.
function rewriteIn(dir: string, file: RegExp, from: string, to: string): number {
  let changed = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) changed += rewriteIn(full, file, from, to)
    else if (file.test(entry.name)) {
      const before = readFileSync(full, 'utf8')
      const after = before.replaceAll(from, to)
      if (after !== before) {
        writeFileSync(full, after)
        changed++
      }
    }
  }
  return changed
}

// An adoption that rewrites nothing would leave the project on the template's own
// copies, and the lint and typecheck below would prove nothing about the packages.
function rewrite(file: RegExp, from: string, to: string): void {
  assert.ok(rewriteIn(app, file, from, to) > 0, `no ${file} in the project references ${from}`)
}

// How a generated project adopts each package, by its published name, in place of
// the template's own copy (the template switches for good in #60). A package with no
// entry fails the test: publishing one means saying how a project consumes it.
const adopt: Record<string, () => void> = {
  '@lntt/biome-config': () => {
    rewrite(/^biome\.json$/, './packages/biome-config/biome.json', '@lntt/biome-config/biome')
    rewrite(/^biome\.json$/, './packages/biome-config/', './node_modules/@lntt/biome-config/')
  },
  '@lntt/typescript-config': () =>
    rewrite(/^tsconfig.*\.json$/, '@smoke-app/typescript-config/', '@lntt/typescript-config/'),
  '@lntt/stylelint-config': () =>
    rewrite(/^\.stylelintrc\.json$/, './packages/stylelint-config', '@lntt/stylelint-config'),
  // No package of the template has database tests yet: a probe package does, the
  // way an app would, and checks the project with the container rule. Its config is
  // the app preset, so the jsdom setup appTest() lists is resolved by name.
  '@lntt/test-utils': () => {
    const probe = join(app, 'packages/db-probe')
    mkdirSync(join(probe, 'drizzle/20260101000000_init'), { recursive: true })
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: '@smoke-app/db-probe', private: true, type: 'module' }),
      'vitest.config.ts':
        "import { testDbPlugin } from '@lntt/test-utils/plugin'\nimport { appTest } from '@lntt/test-utils/vitest'\n" +
        "import { defineConfig } from 'vitest/config'\n\n" +
        "export default defineConfig({ plugins: [testDbPlugin()], test: appTest({ sources: '.' }) })\n",
      'drizzle/20260101000000_init/migration.sql': 'CREATE TABLE probe (id integer PRIMARY KEY);\n',
      'probe.test.ts': [
        'import {',
        '  assertContainerRules,',
        '  assertNoJsdomSetupImports,',
        '  assertNoModuleMocks,',
        '  createTestDb,',
        '  hasTestDatabase,',
        '  txTest,',
        "} from '@lntt/test-utils'",
        "import { assertWaitingWorkspacesRunTheGuard } from '@lntt/test-utils/waits'",
        "import { WORKSPACE_LABEL } from '@lntt/test-utils/workspace'",
        "import { expect, it } from 'vitest'",
        '',
        "const db = createTestDb({ databaseName: 'probe', migrationsFolder: './drizzle' })",
        'const dbIt = txTest(db.withTestDb)',
        '',
        "dbIt('runs on a migrated test database, in the tx fixture', async ({ tx }) => {",
        '  expect(hasTestDatabase()).toBe(true)',
        "  expect(await tx.execute('SELECT id FROM probe')).toHaveLength(0)",
        '})',
        '',
        "it('every container the project starts can be cleaned up', () => {",
        "  assertContainerRules(new URL('../..', import.meta.url).pathname)",
        '})',
        '',
        "it('exports the workspace label from its Node-only subpath', () => {",
        "  expect(WORKSPACE_LABEL).toBe('com.lntt.workspace')",
        '})',
        '',
        // The test guards, from the root export and from the subpath that parses with vite.
        "it('no test mocks a module for the whole worker, and every workspace that waits runs the guard', () => {",
        "  assertNoModuleMocks(new URL('../..', import.meta.url).pathname)",
        "  assertWaitingWorkspacesRunTheGuard(new URL('../..', import.meta.url).pathname)",
        '})',
        '',
        "it('ran the jsdom setup appTest() lists, and no file imports it', () => {",
        '  expect((globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT).toBe(true)',
        "  assertNoJsdomSetupImports(new URL('../..', import.meta.url).pathname)",
        '})',
        '',
      ].join('\n'),
    }
    for (const [path, content] of Object.entries(files)) writeFileSync(join(probe, path), content)
    // From the package directory, as turbo runs it: migrationsFolder resolves from there.
    run('node', [join(app, 'node_modules/vitest/vitest.mjs'), 'run'], probe)
    rmSync(probe, { recursive: true })
  },
  // No app of the template has an e2e suite yet: import it as an app's config would.
  '@lntt/playwright-config': () => {
    const probe = join(app, 'playwright-probe.mjs')
    writeFileSync(
      probe,
      "import { definePlaywrightConfig } from '@lntt/playwright-config'\n" +
        'console.log(definePlaywrightConfig({ port: 4321 }).use.baseURL)\n',
    )
    assert.equal(execFileSync('node', [probe], { cwd: app, encoding: 'utf8' }).trim(), 'http://localhost:4321')
    rmSync(probe)
  },
  // The command the project's tooling and the shared skills call: the installed bin
  // reads the configuration the scaffolder wrote.
  '@lntt/lntt': () => {
    const lntt = join(app, 'node_modules/.bin/lntt')
    run(lntt, ['--help'], app)
    assert.equal(
      execFileSync(lntt, ['get', 'lunette.template'], { cwd: app, encoding: 'utf8' }).trim(),
      '"react-router"',
    )
  },
}

// The packages a generated project installs from npm, installed here from the
// tarballs `pnpm pack` produces, exactly the files a release would publish. The
// project then lints and typechecks on them instead of its own copies.
test('the published packages install into a scaffolded project, which lints, typechecks and tests on them', {
  skip,
}, () => {
  const packages = publishedPackages()
  assert.deepEqual(
    packages.map((p) => p.name).filter((name) => !adopt[name]),
    [],
    'every published package says how a project adopts it',
  )
  const tarballs = join(root, 'tarballs')
  mkdirSync(tarballs)
  for (const { dir } of packages) run('pnpm', ['pack', '--pack-destination', tarballs], dir)
  const files = readdirSync(tarballs).map((f) => join(tarballs, f))
  // The peers a project installs next to the packages.
  const peers = [
    'stylelint@^17.0.0',
    '@playwright/test@^1.61.1',
    'vitest@^4.1.10',
    'vite@^8.0.0',
    'drizzle-orm@1.0.0-rc.4',
  ]
  run('pnpm', ['add', '-w', '-D', '--ignore-scripts', ...files, ...peers], app)

  for (const { name } of packages) adopt[name]?.()
  assert.doesNotMatch(readFileSync(join(app, 'biome.json'), 'utf8'), /packages\/biome-config/)
  run('pnpm', ['lint'], app)
  run('pnpm', ['typecheck'], app)
})
