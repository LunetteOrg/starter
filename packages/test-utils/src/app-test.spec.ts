import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * appTest() run for real: a probe app whose jsdom files share one worker, each
 * reporting what the files before it left in the environment, then leaving some of
 * its own. Three files, because a setup imported from another setup file still
 * reaches the first file of a worker: the leak shows from the second to the third.
 */
const PKG = resolve(__dirname, '..')
const VITEST = join(PKG, 'node_modules/vitest/vitest.mjs')
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const probeFile = `// @vitest-environment jsdom
import { appendFileSync } from 'node:fs'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import { expect, it, vi } from 'vitest'

const files = (globalThis.__probeFiles ??= [])
files.push(import.meta.url)

it('reports what the earlier files left, then leaves some', () => {
  expect(files).toContain(import.meta.url)
  appendFileSync('report.jsonl', JSON.stringify({
    files: files.length,
    head: document.head.childNodes.length,
    cookie: document.cookie,
    fakeTimers: vi.isFakeTimers(),
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
    stubbed: typeof ResizeObserver,
    body: document.body.textContent,
    storage: localStorage.length + sessionStorage.length,
  }) + '\\n')
  document.head.appendChild(document.createElement('style'))
  document.cookie = 'left=1; path=/'
  localStorage.setItem('left', '1')
  sessionStorage.setItem('left', '1')
  render(createElement('p', null, 'rendered'))
  vi.useFakeTimers()
})
`

// A node-environment file of the fast project: the setup's node branch restores the
// clock, and nothing else there would.
const nodeFile = `// @vitest-environment node
import { appendFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'

const files = (globalThis.__probeNodeFiles ??= [])
files.push(import.meta.url)

it('reports the clock the earlier node files left, then fakes it', () => {
  expect(files).toContain(import.meta.url)
  appendFileSync('report.jsonl', JSON.stringify({ node: files.length, fakeTimers: vi.isFakeTimers() }) + '\\n')
  vi.useFakeTimers()
})
`

const heavyFile = `import { appendFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('runs after every other project, isolated from them', () => {
  expect(globalThis.__probeFiles).toBeUndefined()
  appendFileSync('report.jsonl', JSON.stringify({ heavy: true }) + '\\n')
})
`

type Line = {
  files?: number
  head?: number
  cookie?: string
  fakeTimers?: boolean
  act?: boolean
  stubbed?: string
  body?: string
  storage?: number
  node?: number
  heavy?: true
}

/** Runs the probe app under `config` (the body of `vitest.config.mjs`) and returns its report. */
async function runProbe(config: string, extra: Record<string, string> = {}): Promise<Line[]> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-app-test-')))
  dirs.push(dir)
  // vitest, jsdom, react and testing-library from this package's devDependencies.
  for (const name of ['vitest', 'jsdom', 'react', 'react-dom', '@testing-library']) {
    mkdirSync(dirname(join(dir, 'node_modules', name)), { recursive: true })
    symlinkSync(join(PKG, 'node_modules', name), join(dir, 'node_modules', name), 'dir')
  }
  // @lntt/test-utils/jsdom-setup resolved by name, as appTest() lists it, to the
  // source: a link, so the module vitest runs is the source file itself.
  const self = join(dir, 'node_modules/@lntt/test-utils')
  mkdirSync(self, { recursive: true })
  writeFileSync(
    join(self, 'package.json'),
    JSON.stringify({ name: '@lntt/test-utils', type: 'module', exports: { './jsdom-setup': './jsdom-setup.ts' } }),
  )
  symlinkSync(join(PKG, 'src/jsdom-setup.ts'), join(self, 'jsdom-setup.ts'))
  const files: Record<string, string> = {
    'package.json': '{ "name": "probe-app", "type": "module" }\n',
    'vitest.config.mjs': config,
    'one.spec.mjs': probeFile,
    'two.spec.mjs': probeFile,
    'three.spec.mjs': probeFile,
    'node-one.spec.mjs': nodeFile,
    'node-two.spec.mjs': nodeFile,
    'heavy.spec.mjs': heavyFile,
    ...extra,
  }
  for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content)
  await promisify(execFile)(process.execPath, [VITEST, 'run'], { cwd: dir, env: { ...process.env, CI: '' } })
  return readFileSync(join(dir, 'report.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Line)
}

// The setup is linked from outside the probe: vite is told it may serve this package.
const preset = (setupFiles: string) => `import { appTest } from ${JSON.stringify(join(PKG, 'src/vitest.ts'))}
const test = appTest({ sources: '.', last: { name: 'heavy', include: ['heavy.spec.mjs'] } })
export default {
  server: { fs: { allow: ['.', ${JSON.stringify(PKG)}] } },
  test: { ...test, ${setupFiles} maxWorkers: 1, reporters: ['default'] },
}
`

describe('appTest() in a real run', () => {
  // One run serves the two tests that read it.
  let listed: Promise<Line[]> | undefined
  const listedRun = () => (listed ??= runProbe(preset('')))

  it('shares one worker across the fast files, and the listed setup leaves each file clean', async () => {
    const fast = (await listedRun()).filter((line) => !line.heavy && line.node === undefined)
    // Not vacuous: the files did share the worker's registry and environment.
    expect(fast.map((line) => line.files)).toEqual([1, 2, 3])
    for (const line of fast) {
      expect(line).toEqual({
        files: line.files,
        head: 0,
        cookie: '',
        fakeTimers: false,
        act: true,
        stubbed: 'function',
        body: '',
        storage: 0,
      })
    }
  })

  it('gives the node files of the fast project the real clock back after each test', async () => {
    const node = (await listedRun()).filter((line) => line.node !== undefined)
    // Not vacuous: the second file shared the first one's registry.
    expect(node).toEqual([
      { node: 1, fakeTimers: false },
      { node: 2, fakeTimers: false },
    ])
  })

  it('runs the last project once, after the others', async () => {
    const report = await listedRun()
    expect(report.filter((line) => line.heavy)).toHaveLength(1)
    expect(report.at(-1)).toEqual({ heavy: true })
  })

  it('gives each jsdom file a storage where the environment leaves the global undefined', async () => {
    // What vitest's jsdom environment leaves from Node 25 on: Node's own localStorage,
    // undefined without --localstorage-file. Reproduced here on every Node version.
    const nodeStorage = `if (typeof window !== 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true })
}
`
    const report = await runProbe(preset("setupFiles: ['./node-storage.mjs', ...test.setupFiles],"), {
      'node-storage.mjs': nodeStorage,
    })
    const fast = report.filter((line) => line.files !== undefined)
    expect(fast.map(({ files, storage }) => ({ files, storage }))).toEqual([
      { files: 1, storage: 0 },
      { files: 2, storage: 0 },
      { files: 3, storage: 0 },
    ])
  })

  it('leaks from file to file when another setup file imports the jsdom setup', async () => {
    const setup = "import '@lntt/test-utils/jsdom-setup'\n"
    const report = await runProbe(preset("setupFiles: ['./setup.mjs'],"), { 'setup.mjs': setup })
    const third = report.find((line) => line.files === 3)
    expect(third).toMatchObject({ head: 1, cookie: 'left=1', fakeTimers: true, body: 'rendered', storage: 2 })
  })
})
