import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertContainerRules, ryukDisablers, testDbUsers, unlabelledContainers } from './containers.ts'

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
const plugin = 'export default { plugins: [testDbPlugin()] }\n'

describe('testDbUsers', () => {
  const root = project({
    'packages/db/package.json': pkg,
    'packages/db/src/repo.test.ts': "const db = createTestDb({ databaseName: 'db' })\n",
    'packages/db/vitest.config.ts': plugin,
    'apps/web/package.json': pkg,
    'apps/web/app/users.test.ts': 'await withTestDb(async (tx) => {})\n',
    'apps/web/vitest.config.mts': plugin,
    // Every config extension vitest loads counts, not only .ts and .mts.
    'packages/cjs/package.json': pkg,
    'packages/cjs/src/a.test.ts': "createTestDb({ databaseName: 'a' })\n",
    'packages/cjs/vitest.config.cjs': plugin,
    'packages/cts/package.json': pkg,
    'packages/cts/src/a.test.ts': "createTestDb({ databaseName: 'a' })\n",
    'packages/cts/vitest.config.cts': plugin,
    'packages/js/package.json': pkg,
    'packages/js/src/a.test.ts': "createTestDb({ databaseName: 'a' })\n",
    'packages/js/vitest.config.js': plugin,
    'packages/mjs/package.json': pkg,
    'packages/mjs/src/a.test.ts': "createTestDb({ databaseName: 'a' })\n",
    'packages/mjs/vitest.config.mjs': plugin,
    'packages/forgot/package.json': pkg,
    'packages/forgot/src/repo.test.ts': "createTestDb({ databaseName: 'f' })\n",
    'packages/commented/package.json': pkg,
    'packages/commented/src/a.test.ts': "createTestDb({ databaseName: 'a' })\n",
    'packages/commented/vitest.config.ts': '// plugins: [testDbPlugin()]\nexport default {}\n',
    // Containers of its own and no test database: no plugin needed.
    'packages/vault/package.json': pkg,
    'packages/vault/src/vault.test.ts':
      "await new GenericContainer('vault').withLabels({ [WORKSPACE_LABEL]: workspaceRoot() }).start()\n" +
      'await postgresContainer().start()\n',
    'packages/talker/package.json': pkg,
    'packages/talker/src/index.ts': "// createTestDb lives elsewhere\nexport const doc = 'see withTestDb'\n",
    // A directory named like a source file (vitest writes screenshots this way).
    'packages/shots/package.json': pkg,
    'packages/shots/src/__screenshots__/Card.spec.tsx/': '',
  })

  it('finds the workspaces that use the test database, and whether they mount testDbPlugin()', () => {
    expect(testDbUsers(root)).toEqual([
      { name: 'apps/web', mountsPlugin: true },
      { name: 'packages/cjs', mountsPlugin: true },
      { name: 'packages/commented', mountsPlugin: false },
      { name: 'packages/cts', mountsPlugin: true },
      { name: 'packages/db', mountsPlugin: true },
      { name: 'packages/forgot', mountsPlugin: false },
      { name: 'packages/js', mountsPlugin: true },
      { name: 'packages/mjs', mountsPlugin: true },
    ])
  })
})

describe('ryukDisablers', () => {
  const root = project({
    'package.json': '{ "scripts": { "test": "turbo test" } }',
    'packages/env/package.json': pkg,
    'packages/env/src/a.test.ts': "process.env.TESTCONTAINERS_RYUK_DISABLED = 'true'\n",
    'packages/key/package.json': pkg,
    'packages/key/src/setup.mjs': "\nprocess.env['TESTCONTAINERS_RYUK_DISABLED'] = '1'\n",
    'packages/workers/package.json': pkg,
    'packages/workers/vitest.config.ts': "export default { test: { env: { TESTCONTAINERS_RYUK_DISABLED: 'true' } } }\n",
    'packages/quoted/package.json': pkg,
    'packages/quoted/src/env.ts': "export const env = {\n  'TESTCONTAINERS_RYUK_DISABLED': 'true',\n}\n",
    'packages/later/package.json': pkg,
    'packages/later/src/env.ts': "export const env = { CI: '1',\n  TESTCONTAINERS_RYUK_DISABLED: flag }\n",
    'packages/logical/package.json': pkg,
    'packages/logical/src/setup.js': [
      "process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true'",
      "process.env.TESTCONTAINERS_RYUK_DISABLED ||= 'true'",
      "process.env['TESTCONTAINERS_RYUK_DISABLED'] &&= 'true'",
      '',
    ].join('\n'),
    'packages/common/package.json': pkg,
    'packages/common/setup.cjs': "module.exports = { env: { TESTCONTAINERS_RYUK_DISABLED: 'true' } }\n",
    'packages/script/package.json': JSON.stringify(
      { name: 'x', scripts: { build: 'tsc', test: 'TESTCONTAINERS_RYUK_DISABLED=true vitest run' } },
      null,
      2,
    ),
    'packages/crossenv/package.json': JSON.stringify(
      {
        name: 'x',
        scripts: {
          a: 'cross-env TESTCONTAINERS_RYUK_DISABLED=1 vitest',
          b: 'export TESTCONTAINERS_RYUK_DISABLED; vitest',
        },
      },
      null,
      2,
    ),
    // Reading, testing or removing the variable is not setting it.
    'packages/reader/package.json': JSON.stringify(
      {
        name: 'x',
        scripts: { show: 'echo $TESTCONTAINERS_RYUK_DISABLED', drop: 'unset TESTCONTAINERS_RYUK_DISABLED' },
      },
      null,
      2,
    ),
    'packages/reader/src/a.test.ts': [
      "expect(env).not.toHaveProperty('TESTCONTAINERS_RYUK_DISABLED')",
      'if (process.env.TESTCONTAINERS_RYUK_DISABLED) skip()',
      "if (process.env.TESTCONTAINERS_RYUK_DISABLED === 'true') skip()",
      "if (process.env['TESTCONTAINERS_RYUK_DISABLED'] == 'true') skip()",
      'delete process.env.TESTCONTAINERS_RYUK_DISABLED',
      'const v = ci ? process.env.TESTCONTAINERS_RYUK_DISABLED : undefined',
      "const w = ci ? process.env['TESTCONTAINERS_RYUK_DISABLED'] : undefined",
      'type Env = { TESTCONTAINERS_RYUK_DISABLED: string }',
      'type Flags = { CI: boolean, TESTCONTAINERS_RYUK_DISABLED: undefined }',
      '',
    ].join('\n'),
    // A declaration file types the variable; a non-optional key would read as `NAME:`.
    'packages/types/package.json': pkg,
    'packages/types/src/env.d.ts':
      'interface ProcessEnv {\n  TESTCONTAINERS_RYUK_DISABLED?: string\n  TESTCONTAINERS_RYUK_DISABLED: string\n}\n',
    // A literal type reads as an object key; only the declaration files are skipped.
    'packages/types/src/env.d.mts':
      "export interface Env { TESTCONTAINERS_RYUK_DISABLED: string }\nexport declare const env: { TESTCONTAINERS_RYUK_DISABLED: 'true' }\n",
    'packages/types/src/env.d.cts': "export declare const env: { TESTCONTAINERS_RYUK_DISABLED: 'true' }\n",
    'packages/quiet/package.json':
      '{ "name": "x", "description": "TESTCONTAINERS_RYUK_DISABLED=true is not a script" }',
    'packages/quiet/src/a.ts':
      "// TESTCONTAINERS_RYUK_DISABLED = 'true' is the shell's, never ours\n/* nor TESTCONTAINERS_RYUK_DISABLED: 1 */\n",
    'packages/shots/package.json': pkg,
    'packages/shots/src/__screenshots__/Card.spec.tsx/': '',
  })

  it('reports every source that sets the variable, by assignment or object key, with its line', () => {
    expect(ryukDisablers(root)).toEqual([
      { file: 'packages/common/setup.cjs', line: 1 },
      { file: 'packages/crossenv/package.json', line: 4 },
      { file: 'packages/crossenv/package.json', line: 5 },
      { file: 'packages/env/src/a.test.ts', line: 1 },
      { file: 'packages/key/src/setup.mjs', line: 2 },
      { file: 'packages/later/src/env.ts', line: 2 },
      { file: 'packages/logical/src/setup.js', line: 1 },
      { file: 'packages/logical/src/setup.js', line: 2 },
      { file: 'packages/logical/src/setup.js', line: 3 },
      { file: 'packages/quoted/src/env.ts', line: 2 },
      { file: 'packages/script/package.json', line: 5 },
      { file: 'packages/workers/vitest.config.ts', line: 1 },
    ])
  })

  it('reports a root package.json script on its line, minified with other keys', () => {
    const scripted = project({
      'package.json': '{"name":"x","scripts":{"build":"tsc","test":"TESTCONTAINERS_RYUK_DISABLED=1 turbo test"}}',
    })
    expect(ryukDisablers(scripted)).toEqual([{ file: 'package.json', line: 1 }])
  })

  it("reports a script on its value's line when the name sits on another", () => {
    const split = project({
      'package.json': '{\n  "scripts": {\n    "test":\n      "TESTCONTAINERS_RYUK_DISABLED=1 vitest"\n  }\n}\n',
    })
    expect(ryukDisablers(split)).toEqual([{ file: 'package.json', line: 4 }])
  })

  it("reports a script on its own line, not on the same text's earlier in the file", () => {
    const echoed = project({
      'package.json':
        '{\n  "description": "TESTCONTAINERS_RYUK_DISABLED=1 vitest",\n  "scripts": {\n    "test": "TESTCONTAINERS_RYUK_DISABLED=1 vitest"\n  }\n}\n',
    })
    expect(ryukDisablers(echoed)).toEqual([{ file: 'package.json', line: 4 }])
  })

  it('reports a script whose value is spelled with escapes on line 1', () => {
    const escaped = project({
      'package.json': '{\n  "scripts": {\n    "test": "TESTCONTAINERS_RYUK_DISABLED=1 vitest \\u0072un"\n  }\n}\n',
    })
    expect(ryukDisablers(escaped)).toEqual([{ file: 'package.json', line: 1 }])
  })

  it('names the package.json it cannot parse', () => {
    const broken = project({
      'package.json': '{ "name": "x" }',
      'packages/broken/package.json': '{ "name": "x", }',
    })
    expect(() => ryukDisablers(broken)).toThrow(/^packages\/broken\/package\.json is not valid JSON: \S/)
  })

  it('names the package.json that parses to something other than an object', () => {
    for (const manifest of ['null', '"x"', '[]']) {
      const odd = project({ 'package.json': '{ "name": "x" }', 'packages/odd/package.json': manifest })
      expect(() => ryukDisablers(odd)).toThrow(/^packages\/odd\/package\.json is not a JSON object/)
    }
  })
})

describe('unlabelledContainers', () => {
  const labels = '{ [WORKSPACE_LABEL]: workspaceRoot() }'
  const root = project({
    'packages/a/package.json': pkg,
    'packages/a/src/chain.test.ts': [
      "const vault = await new GenericContainer('vault:1.18')",
      "  .withEnvironment({ VAULT_DEV_ROOT_TOKEN_ID: 'root' })",
      "  .withTmpFs({ '/data': 'rw' })",
      `  .withLabels(${labels})`,
      '  .start()',
      '',
    ].join('\n'),
    'packages/a/src/bare.test.ts': "\n\nawait new PostgreSqlContainer('postgres:17').withReuse().start()\n",
    'packages/a/src/other.test.ts': "await new GenericContainer('redis').withLabels({ other: 'x' }).start()\n",
    'packages/a/src/string.test.ts':
      "await new GenericContainer('redis').withLabels({ 'WORKSPACE_LABEL': 'x' }).start()\n",
    // The constant must be the computed key: the brackets forgotten, as a value, or in
    // another call, it labels nothing with it.
    'packages/a/src/literal.test.ts':
      "await new GenericContainer('redis').withLabels({ WORKSPACE_LABEL: 'x' }).start()\n",
    'packages/a/src/value.test.ts':
      "await new GenericContainer('redis').withLabels({ team: WORKSPACE_LABEL }).start()\n",
    'packages/a/src/elsewhere.test.ts':
      "await new GenericContainer('redis').withEnvironment({ [WORKSPACE_LABEL]: 'x' }).start()\n",
    'packages/a/src/later.test.ts': [
      "const container = new GenericContainer('redis')",
      `container.withLabels(${labels})`,
      '',
    ].join('\n'),
    // The withLabels call never closes: nothing in it labels.
    'packages/a/src/unclosed.test.ts': `await new GenericContainer('redis').withLabels(${labels}\n`,
    'packages/a/src/e2e.ts': "await new GenericContainer('mailpit').withLabels({ [E2E_LABEL]: 'run' }).start()\n",
    'packages/a/src/plain.js': "await new GenericContainer('redis').start()\n",
    'packages/a/src/common.cjs': "new GenericContainer('redis').start()\n",
    'packages/a/src/dollar.ts': "await new GenericContainer('mailpit').withLabels({ [$LABEL]: 'run' }).start()\n",
    'packages/a/src/talk.ts': "// new GenericContainer('x')\nconst s = \"new PostgreSqlContainer('y')\"\n",
    // Links written `?.`, after a non-null `!`, or with generic arguments still chain.
    'packages/a/src/optional.test.ts': `await new GenericContainer('redis')?.withLabels(${labels}).start()\n`,
    'packages/a/src/nonnull.test.ts': `await new GenericContainer('redis').withExposedPorts(6379)!\n  .withLabels(${labels}).start()\n`,
    'packages/a/src/generic.test.ts':
      "await new GenericContainer<Redis>('redis').withLabels<Record<string, string>>({ [ WORKSPACE_LABEL ]: 'x' }).start()\n",
    'packages/shots/package.json': pkg,
    'packages/shots/src/__screenshots__/Card.spec.tsx/': '',
  })

  it('reports every container whose chain names no label constant as a computed key of withLabels', () => {
    expect(unlabelledContainers(root)).toEqual([
      { file: 'packages/a/src/bare.test.ts', line: 3 },
      { file: 'packages/a/src/common.cjs', line: 1 },
      { file: 'packages/a/src/dollar.ts', line: 1 },
      { file: 'packages/a/src/e2e.ts', line: 1 },
      { file: 'packages/a/src/elsewhere.test.ts', line: 1 },
      { file: 'packages/a/src/later.test.ts', line: 1 },
      { file: 'packages/a/src/literal.test.ts', line: 1 },
      { file: 'packages/a/src/other.test.ts', line: 1 },
      { file: 'packages/a/src/plain.js', line: 1 },
      { file: 'packages/a/src/string.test.ts', line: 1 },
      { file: 'packages/a/src/unclosed.test.ts', line: 1 },
      { file: 'packages/a/src/value.test.ts', line: 1 },
    ])
  })

  it('accepts the label constants given in options, besides WORKSPACE_LABEL, spelled as code', () => {
    const files = unlabelledContainers(root, { labels: ['E2E_LABEL', '$LABEL'] }).map((v) => v.file)
    expect(files).not.toContain('packages/a/src/e2e.ts')
    expect(files).not.toContain('packages/a/src/dollar.ts')
  })
})

describe('assertContainerRules', () => {
  it('throws once, listing every violation under its rule with what to do', () => {
    const root = project({
      'packages/db/package.json': pkg,
      'packages/db/src/repo.test.ts': "createTestDb({ databaseName: 'db' })\n",
      'packages/db/src/setup.ts': "process.env.TESTCONTAINERS_RYUK_DISABLED = 'true'\n",
      'packages/db/src/vault.test.ts': "await new GenericContainer('vault').start()\n",
    })
    let message = ''
    try {
      assertContainerRules(root)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/testDbPlugin\(\):\n {2}- packages\/db\n {2}Mount testDbPlugin\(\)/)
    expect(message).toMatch(
      /TESTCONTAINERS_RYUK_DISABLED \(an assignment or an object key\):\n {2}- packages\/db\/src\/setup\.ts:1\n {2}Remove the assignment/,
    )
    expect(message).toMatch(/in their chain:\n {2}- packages\/db\/src\/vault\.test\.ts:1\n {2}Add \.withLabels/)
  })

  it('names every accepted label constant in the message', () => {
    const root = project({
      'packages/e2e/package.json': pkg,
      'packages/e2e/setup.ts': "await new GenericContainer('mailpit').start()\n",
    })
    expect(() => assertContainerRules(root, { labels: ['E2E_LABEL'] })).toThrow(
      /no label constant \(WORKSPACE_LABEL, E2E_LABEL\) as a computed key/,
    )
  })

  it('passes a project that follows all three rules', () => {
    const clean = project({
      'packages/db/package.json': pkg,
      'packages/db/src/repo.test.ts': "createTestDb({ databaseName: 'db' })\n",
      'packages/db/vitest.config.ts': plugin,
      'packages/e2e/package.json': pkg,
      'packages/e2e/setup.ts': "await new GenericContainer('mailpit').withLabels({ [E2E_LABEL]: 'run' }).start()\n",
    })
    expect(() => assertContainerRules(clean, { labels: ['E2E_LABEL'] })).not.toThrow()
  })
})
