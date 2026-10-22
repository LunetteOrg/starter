import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { blankCommentsAndStrings } from './source-scan.ts'
import { lineAt, projectTestModules, TEST_GUARDS_RECORD } from './test-modules.ts'

const STATIC_MOCK = /\bvi\s*\.\s*mock\s*\(/g
const SCOPED_MOCK = /\bvi\s*\.\s*doMock\s*\(/g
const UNMOCK = /\bvi\s*\.\s*doUnmock\s*\(/g
const REGISTRY_RESET = /\bvi\s*\.\s*resetModules\s*\(/g

export interface ModuleMockViolation {
  line: number
  message: string
}

export interface NoModuleMocksOptions {
  /** Globs relative to the root that are not scanned, on top of build output, `e2e/` and `__fixtures__/`. */
  ignore?: string[]
}

function indexes(code: string, pattern: RegExp): number[] {
  return [...code.matchAll(pattern)].map((match) => match.index)
}

/**
 * The module mocks in one test module that a shared module registry cannot hold: a
 * hoisted `vi.mock`, and a `vi.doMock` without `vi.resetModules()` before the first
 * `vi.doMock` and after the last `vi.doUnmock`. Comments and strings do not count.
 */
export function findModuleMocks(source: string): ModuleMockViolation[] {
  const code = blankCommentsAndStrings(source)
  const found: ModuleMockViolation[] = indexes(code, STATIC_MOCK).map((at) => ({
    line: lineAt(code, at),
    message:
      'a hoisted vi.mock applies to every file sharing the worker: inject the dependency, ' +
      'or replace it inside the test with vi.doMock between two vi.resetModules()',
  }))

  const mocks = indexes(code, SCOPED_MOCK)
  const firstMock = mocks[0]
  if (firstMock === undefined) return found
  const unmocks = indexes(code, UNMOCK)
  const resets = indexes(code, REGISTRY_RESET)
  const lastUnmock = unmocks.at(-1)
  const line = lineAt(code, firstMock)
  if (!resets.some((at) => at < firstMock)) {
    found.push({
      line,
      message: 'vi.doMock with no vi.resetModules() before it: the import returns the copy already cached',
    })
  } else if (lastUnmock === undefined) {
    found.push({ line, message: 'vi.doMock with no vi.doUnmock: the next file sharing the worker inherits the mock' })
  } else if (!resets.some((at) => at > lastUnmock)) {
    found.push({
      line,
      message: 'no vi.resetModules() after the last vi.doUnmock: the next file sharing the worker gets the mocked copy',
    })
  }
  return found
}

/**
 * Fails on every module mock a shared module registry (`isolate: false`) cannot hold,
 * in the specs, tests, stories and test helpers (`*-kit.ts(x)`, anything under `test/`)
 * of the workspaces under `apps/*` and `packages/*` of `root`.
 *
 * @example
 * ```ts
 * it('no test mocks a module for the whole worker', () => {
 *   assertNoModuleMocks(resolve(__dirname, '../../..'))
 * })
 * ```
 */
export function assertNoModuleMocks(root: string, options: NoModuleMocksOptions = {}): void {
  const files = projectTestModules(root, options.ignore)
  if (files.length === 0) {
    throw new Error(`assertNoModuleMocks: no test file found under apps/* or packages/* of ${root}`)
  }
  const offenders = files.flatMap((file) =>
    findModuleMocks(readFileSync(resolve(root, file), 'utf8')).map((v) => `  - ${file}:${v.line}  ${v.message}`),
  )
  if (offenders.length > 0) {
    throw new Error(
      `These test modules mock modules in a way a shared module registry cannot hold:\n${offenders.join('\n')}\n` +
        `See ${TEST_GUARDS_RECORD} (module mocks).`,
    )
  }
}
