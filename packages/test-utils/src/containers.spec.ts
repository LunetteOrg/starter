import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertContainerUsersMountAPlugin, containerUsers } from './containers.ts'

/** A project's workspace with its apps and packages, built from file contents. */
function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-containers-')))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    if (path.endsWith('/')) mkdirSync(join(root, path), { recursive: true })
    else writeFileSync(join(root, path), content)
  }
  return root
}

const pkg = '{ "name": "x" }'

describe('containerUsers', () => {
  const root = project({
    'packages/db/package.json': pkg,
    'packages/db/src/repo.test.ts': "const db = createTestDb({ databaseName: 'db' })\n",
    'packages/db/vitest.config.ts': 'export default { plugins: [testDbPlugin()] }\n',
    'apps/web/package.json': pkg,
    'apps/web/e2e/setup.ts': 'await postgresContainer().start()\n',
    'apps/web/vitest.config.mts': 'export default { plugins: [ryukDisabledPlugin()] }\n',
    'packages/forgot/package.json': pkg,
    'packages/forgot/src/vault.test.ts': "await new GenericContainer('vault').start()\n",
    'packages/commented/package.json': pkg,
    'packages/commented/src/a.test.ts': "createTestDb({ databaseName: 'a' })\n",
    'packages/commented/vitest.config.ts': '// plugins: [testDbPlugin()]\nexport default {}\n',
    'packages/talker/package.json': pkg,
    'packages/talker/src/index.ts': "// createTestDb lives elsewhere\nexport const doc = 'see createTestDb'\n",
    // A directory named like a source file (vitest writes screenshots this way).
    'packages/shots/package.json': pkg,
    'packages/shots/src/__screenshots__/Card.spec.tsx/': '',
  })

  it('finds every workspace that starts containers, and whether it mounts a plugin', () => {
    expect(containerUsers(root)).toEqual([
      { name: 'apps/web', mountsPlugin: true },
      { name: 'packages/commented', mountsPlugin: false },
      { name: 'packages/db', mountsPlugin: true },
      { name: 'packages/forgot', mountsPlugin: false },
    ])
  })

  it('fails naming the workspaces that start containers without a plugin', () => {
    expect(() => assertContainerUsersMountAPlugin(root)).toThrow(/packages\/commented[\s\S]*packages\/forgot/)
  })

  it('passes a project whose container users all mount one', () => {
    const clean = project({
      'packages/db/package.json': pkg,
      'packages/db/src/repo.test.ts': "createTestDb({ databaseName: 'db' })\n",
      'packages/db/vitest.config.ts': 'export default { plugins: [testDbPlugin()] }\n',
    })
    expect(() => assertContainerUsersMountAPlugin(clean)).not.toThrow()
  })
})
