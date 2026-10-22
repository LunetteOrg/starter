import { describe, expect, it } from 'vitest'
import { probeProject } from './probe-kit.ts'
import { assertTestsUseTxFixture, findDirectTestDbCalls } from './tx-fixture.ts'

const pkg = '{ "name": "x" }'

const FIXTURE = "import { createTestDb, txTest } from '@lntt/test-utils'\nexport const it = txTest(db.withTestDb)\n"

describe('findDirectTestDbCalls', () => {
  it.each([
    'await db.withTestDb(seed)',
    'await withTestDb(seed)',
    'await testDb.withTestDb (run)',
  ])('reports %s', (source) => {
    expect(findDirectTestDbCalls(source)).toEqual([1])
  })

  it.each([
    'export const it = txTest(db.withTestDb)',
    "// await db.withTestDb(seed)\nconst doc = 'db.withTestDb(fn)'",
    'const { withTestDb } = createTestDb(options)',
  ])('lets %s through', (source) => {
    expect(findDirectTestDbCalls(source)).toEqual([])
  })
})

describe('assertTestsUseTxFixture', () => {
  it('fails naming each file and line that calls withTestDb, in tests and test support', () => {
    const root = probeProject({
      'apps/web/package.json': pkg,
      'apps/web/app/test/db.ts': FIXTURE,
      'apps/web/app/users.test.ts': "import { db } from './test/db.ts'\n\nawait db.withTestDb(seed)\n",
      'apps/web/app/seed-kit.ts': 'export const seed = () => db.withTestDb(insert)\n',
      // Not test modules: the app's own code, a probe kept as a fixture.
      'apps/web/app/lib/db.ts': 'db.withTestDb(fn)\n',
      'apps/web/app/__fixtures__/x.test.ts': 'db.withTestDb(fn)\n',
    })
    let message = ''
    try {
      assertTestsUseTxFixture(root)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message.match(/apps\/web\/\S+:\d+/g)).toEqual(['apps/web/app/seed-kit.ts:1', 'apps/web/app/users.test.ts:3'])
    expect(message).toMatch(/txTest[\s\S]*\{ tx \}[\s\S]*docs\/adr\/test-guards\.md/)
  })

  it('passes a project whose tests take tx from the fixture, built from withTestDb by reference', () => {
    const root = probeProject({
      'apps/web/package.json': pkg,
      'apps/web/app/test/db.ts': FIXTURE,
      'apps/web/app/users.test.ts': "import { it } from './test/db.ts'\nit('finds a user', async ({ tx }) => {})\n",
    })
    expect(() => assertTestsUseTxFixture(root)).not.toThrow()
  })

  it('skips the paths it is told to ignore', () => {
    const root = probeProject({
      'apps/web/package.json': pkg,
      'apps/web/app/users.test.ts': "it('x', async ({ tx }) => {})\n",
      'apps/web/vendor/x.test.ts': 'db.withTestDb(fn)\n',
    })
    expect(() => assertTestsUseTxFixture(root, { ignore: ['apps/web/vendor/**'] })).not.toThrow()
  })

  it('fails when it finds no test file, rather than pass on nothing', () => {
    expect(() => assertTestsUseTxFixture(probeProject({ 'apps/web/package.json': pkg }))).toThrow(/no test file/)
  })
})
