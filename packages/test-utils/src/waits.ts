import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseAst } from 'vite'
import { blankCommentsAndStrings } from './source-scan.ts'
import { lineAt, TEST_GUARDS_RECORD, testModules, workspaces, workspaceTestModules } from './test-modules.ts'

/** The identifier a wait passes as its timeout: `const WAIT = { timeout: 5_000 }`. */
const TIMEOUT = 'WAIT'

// testing-library's async queries. A repository's `findById` or `findBySlug` shares
// the prefix and is not a wait.
const FIND_QUERY = /^find(All)?By(Role|LabelText|PlaceholderText|Text|DisplayValue|AltText|Title|TestId)$/
const WAIT_CALLS = new Set(['waitFor', 'waitForElementToBeRemoved'])

/** A guard file calls this; mentioning it in a comment or a string does not count. */
const GUARD_CALL = /\bassertWaitsDeclareTimeout\s*\(/
/** The guard is a test of the workspace, which its test task runs. */
const TEST_FILE = /\.(spec|test)\.[cm]?tsx?$/

export interface Wait {
  line: number
  /** The function called: `findByText`, `waitFor`. */
  call: string
  /** Whether it passes `WAIT` where the timeout goes. */
  timed: boolean
}

export interface WaitGuardOptions {
  /** Globs relative to the root that are not scanned, on top of build output, `e2e/` and `__fixtures__/`. */
  ignore?: string[]
}

type AstNode = { type: string; start: number; [field: string]: unknown }

function isNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'type') === 'string'
}

function calleeName(callee: unknown): string | undefined {
  if (!isNode(callee)) return undefined
  if (callee.type === 'Identifier') return String(callee.name)
  if (callee.type === 'MemberExpression' && !callee.computed && isNode(callee.property)) {
    return callee.property.type === 'Identifier' ? String(callee.property.name) : undefined
  }
  return undefined
}

/** Where the timeout goes: `findBy*(query, options, waitOptions)`, `waitFor(callback, options)`. */
function timeoutPosition(name: string): number | undefined {
  if (FIND_QUERY.test(name)) return 2
  if (WAIT_CALLS.has(name)) return 1
  return undefined
}

function collect(value: unknown, source: string, found: Wait[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, source, found)
    return
  }
  if (!isNode(value)) return
  if (value.type === 'CallExpression') {
    const call = calleeName(value.callee)
    const position = call === undefined ? undefined : timeoutPosition(call)
    if (call !== undefined && position !== undefined) {
      const args = Array.isArray(value.arguments) ? value.arguments : []
      const timeout: unknown = args[position]
      found.push({
        line: lineAt(source, value.start),
        call,
        timed: isNode(timeout) && timeout.type === 'Identifier' && timeout.name === TIMEOUT,
      })
    }
  }
  for (const [field, child] of Object.entries(value)) {
    if (field !== 'type' && typeof child === 'object') collect(child, source, found)
  }
}

/**
 * Every `findBy*`, `findAllBy*`, `waitFor`, `vi.waitFor` and `waitForElementToBeRemoved`
 * call in `source`, and whether it passes `WAIT` as its timeout. Parsed, not matched:
 * a call in a comment or a string is no call.
 */
export function findWaits(source: string, lang: 'ts' | 'tsx' = 'tsx'): Wait[] {
  const found: Wait[] = []
  collect(parseAst(source, { lang }), source, found)
  return found
}

function langOf(path: string): 'ts' | 'tsx' {
  return path.endsWith('x') ? 'tsx' : 'ts'
}

function waitsIn(dir: string, path: string): Wait[] {
  try {
    return findWaits(readFileSync(resolve(dir, path), 'utf8'), langOf(path))
  } catch (error) {
    throw new Error(`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Fails on every wait in the specs, tests, stories and test helpers (`*-kit.ts(x)`,
 * anything under `test/`) of one workspace that does not pass `WAIT` as its timeout.
 * Call it from a spec of each workspace whose tests wait, so the workspace's own test
 * task fails; `label` is how messages name the workspace (`apps/web`).
 *
 * @example
 * ```ts
 * // apps/web/app/waits.spec.ts
 * it('every findBy* and waitFor declares its timeout', () => {
 *   assertWaitsDeclareTimeout(resolve(__dirname, '..'), 'apps/web')
 * })
 * ```
 */
export function assertWaitsDeclareTimeout(workspace: string, label = '.'): void {
  const files = testModules(workspace)
  if (files.length === 0) throw new Error(`assertWaitsDeclareTimeout: no test file found under ${label}`)
  const offenders = files.flatMap((path) =>
    waitsIn(workspace, path)
      .filter((wait) => !wait.timed)
      .map(({ line, call }) => `  - ${label}/${path}:${line} ${call}`),
  )
  if (offenders.length > 0) {
    throw new Error(
      `These waits do not pass ${TIMEOUT} as their timeout:\n${offenders.join('\n')}\n` +
        `Declare \`const ${TIMEOUT} = { timeout: 5_000 }\` in the file and pass it on every call: ` +
        `findBy*(query, options, ${TIMEOUT}), waitFor(callback, ${TIMEOUT}); never a global configure(). ` +
        `See ${TEST_GUARDS_RECORD} (waits).`,
    )
  }
}

/**
 * The rule that arms itself: every workspace under `apps/*` and `packages/*` of `root`
 * whose test modules wait (timed or not) has a test module that calls
 * `assertWaitsDeclareTimeout`, so a new package that waits cannot skip the guard.
 */
export function assertWaitingWorkspacesRunTheGuard(root: string, options: WaitGuardOptions = {}): void {
  const found = workspaces(root)
  if (found.length === 0) {
    throw new Error(`assertWaitingWorkspacesRunTheGuard: no workspace found under apps/* or packages/* of ${root}`)
  }
  const unguarded = found.flatMap((workspace) => {
    const dir = resolve(root, workspace)
    const files = workspaceTestModules(root, workspace, options.ignore)
    const waiting = files.filter((path) => waitsIn(dir, path).length > 0)
    if (waiting.length === 0) return []
    const guarded = files.some(
      (path) =>
        TEST_FILE.test(path) && GUARD_CALL.test(blankCommentsAndStrings(readFileSync(resolve(dir, path), 'utf8'))),
    )
    return guarded ? [] : [`  - ${workspace} (${waiting.join(', ')})`]
  })
  if (unguarded.length > 0) {
    throw new Error(
      `These workspaces wait in their tests but no test of theirs calls assertWaitsDeclareTimeout ` +
        `from @lntt/test-utils/waits:\n${unguarded.join('\n')}\n` +
        `Add a spec that calls it on the workspace, so a wait without ${TIMEOUT} fails the workspace's own test task. ` +
        `See ${TEST_GUARDS_RECORD} (waits).`,
    )
  }
}
