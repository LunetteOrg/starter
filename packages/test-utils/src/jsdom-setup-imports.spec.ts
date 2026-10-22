import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertNoJsdomSetupImports, findJsdomSetupImports } from './jsdom-setup-imports.ts'

/** A project's workspace with its apps and packages, built from file contents. */
function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-jsdom-setup-')))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

const pkg = '{ "name": "x" }'
const listed = "export default { test: { setupFiles: ['@lntt/test-utils/jsdom-setup'] } }\n"

describe('findJsdomSetupImports', () => {
  const root = project({
    'apps/web/package.json': pkg,
    'apps/web/vitest.config.ts': listed,
    'apps/web/test/setup.ts': "import '@testing-library/jest-dom/vitest'\nimport '@lntt/test-utils/jsdom-setup'\n",
    'packages/ui/package.json': pkg,
    'packages/ui/vitest.setup.mjs': "await import('@lntt/test-utils/jsdom-setup')\n",
    'packages/ui/src/require.cjs': "require('@lntt/test-utils/jsdom-setup')\n",
    'packages/ui/src/from.ts': "export * from '@lntt/test-utils/jsdom-setup'\n",
    'packages/talker/package.json': pkg,
    'packages/talker/src/notes.ts':
      "// never import '@lntt/test-utils/jsdom-setup' here\nexport const tip = \"import '@lntt/test-utils/jsdom-setup'\"\n",
    'packages/ui/src/Upper.tsx': "import '@lntt/test-utils/jsdom-setup'\n",
    'packages/ui/src/kit.jsx': "import '@lntt/test-utils/jsdom-setup'\n",
    'packages/ui/src/esm.mts': "import '@lntt/test-utils/jsdom-setup'\n",
    'packages/ui/src/cjs.cts': "require('@lntt/test-utils/jsdom-setup')\n",
    // By path, to the source or the build in a workspace: two in one file, in line order.
    'packages/ui/test/paths.ts':
      "import '../../test-utils/src/jsdom-setup.ts'\nimport { x } from './x'\nawait import('../../test-utils/dist/jsdom-setup.js')\n",
    // Other extensions of the build or the source.
    'packages/ui/test/extensions.ts':
      "import '../../test-utils/dist/jsdom-setup.mjs'\nrequire('../../test-utils/src/jsdom-setup.cts')\n",
    // A string holding a keyword before the import, on the same line.
    'packages/ui/test/after-string.ts': "const k = 'import'; import '@lntt/test-utils/jsdom-setup'\n",
    // The app's own, at a path that does not say which package holds it.
    'apps/web/test/own-test-utils.ts': "import '../test-utils/src/jsdom-setup'\n",
    // The app's own setup file, only named like it, and modules that only start like it.
    'apps/web/test/own.ts': [
      "import './jsdom-setup.ts'",
      "import '../shared/src/jsdom-setup'",
      "import '../my-test-utils/src/jsdom-setup'",
      "import '../../acme-test-utils/dist/jsdom-setup'",
      "import { findJsdomSetupImports } from '@lntt/test-utils/jsdom-setup-imports'",
      "import { JSDOM_SETUP_PATH } from '../../packages/test-utils/src/jsdom-setup-path.ts'",
      '',
    ].join('\n'),
    'packages/talker/node_modules/dep/index.js': "import '@lntt/test-utils/jsdom-setup'\n",
    // Generated or built: no source of the project's.
    'packages/talker/dist/index.js': "import '@lntt/test-utils/jsdom-setup'\n",
    'packages/talker/build/server.js': "import '@lntt/test-utils/jsdom-setup'\n",
    'packages/talker/coverage/report.js': "import '@lntt/test-utils/jsdom-setup'\n",
    'apps/web/.react-router/types/app.ts': "import '@lntt/test-utils/jsdom-setup'\n",
  })

  it('finds every import of the setup, by name or path, by file and line, and none of the listings or mentions', () => {
    // Sorted by code unit, on every machine: `Upper` before `cjs`, which a locale puts after.
    expect(findJsdomSetupImports(root)).toEqual([
      { file: 'apps/web/test/own-test-utils.ts', line: 1 },
      { file: 'apps/web/test/setup.ts', line: 2 },
      { file: 'packages/ui/src/Upper.tsx', line: 1 },
      { file: 'packages/ui/src/cjs.cts', line: 1 },
      { file: 'packages/ui/src/esm.mts', line: 1 },
      { file: 'packages/ui/src/from.ts', line: 1 },
      { file: 'packages/ui/src/kit.jsx', line: 1 },
      { file: 'packages/ui/src/require.cjs', line: 1 },
      { file: 'packages/ui/test/after-string.ts', line: 1 },
      { file: 'packages/ui/test/extensions.ts', line: 1 },
      { file: 'packages/ui/test/extensions.ts', line: 2 },
      { file: 'packages/ui/test/paths.ts', line: 1 },
      { file: 'packages/ui/test/paths.ts', line: 3 },
      { file: 'packages/ui/vitest.setup.mjs', line: 1 },
    ])
  })

  it('fails naming each import and what to do instead', () => {
    expect(() => assertNoJsdomSetupImports(root)).toThrow(
      /setupFiles[\s\S]*vitest-preset\.md[\s\S]*apps\/web\/test\/setup\.ts:2[\s\S]*packages\/ui\/vitest\.setup\.mjs:1/,
    )
  })

  it('passes a project that only lists it', () => {
    const clean = project({ 'apps/web/package.json': pkg, 'apps/web/vitest.config.ts': listed })
    expect(() => assertNoJsdomSetupImports(clean)).not.toThrow()
  })

  it('finds no import in this repo', () => {
    expect(() => assertNoJsdomSetupImports(join(__dirname, '../../..'))).not.toThrow()
  })

  it('fails on a root with no workspace rather than pass on nothing', () => {
    expect(() => assertNoJsdomSetupImports(project({ 'README.md': '' }))).toThrow(/no workspace/)
  })
})
