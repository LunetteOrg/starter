import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseAst } from 'vite'
import { lineAt, TEST_GUARDS_RECORD, testModules, workspaces, workspaceTestModules } from './test-modules.ts'

/** The identifier a wait passes as its timeout: `const WAIT = { timeout: 5_000 }`. */
const TIMEOUT = 'WAIT'

// testing-library's async queries. A repository's `findById` or `findBySlug` shares
// the prefix and is not a wait.
const FIND_QUERY = /^find(All)?By(Role|LabelText|PlaceholderText|Text|DisplayValue|AltText|Title|TestId)$/
const WAIT_CALLS = new Set(['waitFor', 'waitForElementToBeRemoved'])
/**
 * The modules a `waitFor` or `waitForElementToBeRemoved` counts from: testing-library's
 * packages, and Storybook's re-export of them. A function of the project by that name,
 * or Playwright's `locator.waitFor()`, is no wait.
 */
const WAIT_MODULE = /^(@testing-library\/[^/]+|storybook\/test|@storybook\/test)$/

/** A guard file calls this; mentioning it in a comment or a string does not count. */
const GUARD = 'assertWaitsDeclareTimeout'
/** Where a guard file imports {@link GUARD} from: a function of its own by that name is no guard. */
const GUARD_MODULE = '@lntt/test-utils/waits'
/** The vitest functions whose callback the run calls: tests, suites and hooks. */
const RUNS_CALLBACK = new Set(['it', 'test', 'describe', 'suite', 'beforeAll', 'beforeEach', 'afterAll', 'afterEach'])
/** Modifiers under which a callback may not run, or runs expecting a failure. */
const MAY_NOT_RUN = new Set(['skip', 'todo', 'skipIf', 'runIf', 'fails'])
const FUNCTION = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])
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
  /**
   * Globs that are not scanned, on top of build output, `e2e/` and `__fixtures__/`: relative
   * to the root, or to the workspace for {@link assertWaitsDeclareTimeout}.
   */
  ignore?: string[]
}

type AstNode = { type: string; start: number; [field: string]: unknown }

function isNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'type') === 'string'
}

/** The name a member expression reads: `.findByText`, or `['findByText']` with a string literal. */
function propertyName(member: AstNode): string | undefined {
  const property = member.property
  if (!isNode(property)) return undefined
  if (!member.computed) return property.type === 'Identifier' ? String(property.name) : undefined
  return property.type === 'Literal' && typeof property.value === 'string' ? property.value : undefined
}

function calleeName(callee: unknown): string | undefined {
  if (!isNode(callee)) return undefined
  if (callee.type === 'Identifier') return String(callee.name)
  return callee.type === 'MemberExpression' ? propertyName(callee) : undefined
}

/** The name an import specifier takes from its module: `waitFor` in `{ waitFor as eventually }`. */
function importedName(specifier: AstNode): string | undefined {
  const imported = specifier.imported
  if (!isNode(imported)) return undefined
  return imported.type === 'Identifier' ? String(imported.name) : String(imported.value)
}

/** The top-level imports of a module, as `{ source, specifiers }`. */
function importsOf(ast: unknown): { source: unknown; specifiers: AstNode[] }[] {
  const body = isNode(ast) && Array.isArray(ast.body) ? ast.body : []
  return body.flatMap((statement) =>
    isNode(statement) && statement.type === 'ImportDeclaration' && isNode(statement.source)
      ? [
          {
            source: statement.source.value,
            specifiers: (Array.isArray(statement.specifiers) ? statement.specifiers : []).filter(isNode),
          },
        ]
      : [],
  )
}

/**
 * The local names under which a module imports testing-library's waits from a
 * {@link WAIT_MODULE}: each function, by the name it is called (`eventually` for
 * `{ waitFor as eventually }`), and each namespace (`rtl` for `* as rtl`).
 */
interface WaitImports {
  functions: Map<string, string>
  namespaces: Set<string>
}

function waitImports(ast: unknown): WaitImports {
  const functions = new Map<string, string>()
  const namespaces = new Set<string>()
  for (const { source, specifiers } of importsOf(ast)) {
    if (typeof source !== 'string' || !WAIT_MODULE.test(source)) continue
    for (const specifier of specifiers) {
      if (!isNode(specifier.local)) continue
      const local = String(specifier.local.name)
      if (specifier.type === 'ImportNamespaceSpecifier') namespaces.add(local)
      const imported = specifier.type === 'ImportSpecifier' ? importedName(specifier) : undefined
      if (imported !== undefined && WAIT_CALLS.has(imported)) functions.set(local, imported)
    }
  }
  return { functions, namespaces }
}

/**
 * Which wait a callee is, if any: a `findBy*` by its name, wherever it comes from; a
 * `waitFor` or `waitForElementToBeRemoved` imported from a {@link WAIT_MODULE}, called
 * by its local name or through the namespace; `vi.waitFor`.
 */
function waitCall(callee: unknown, imports: WaitImports): string | undefined {
  const name = calleeName(callee)
  if (name === undefined || !isNode(callee)) return undefined
  if (FIND_QUERY.test(name)) return name
  if (callee.type === 'Identifier') return imports.functions.get(name)
  const object = callee.object
  if (!WAIT_CALLS.has(name) || !isNode(object) || object.type !== 'Identifier') return undefined
  if (imports.namespaces.has(String(object.name))) return name
  return object.name === 'vi' && name === 'waitFor' ? name : undefined
}

/** Where the timeout goes: `findBy*(query, options, waitOptions)`, `waitFor(callback, options)`. */
function timeoutPosition(name: string): number {
  return FIND_QUERY.test(name) ? 2 : 1
}

/** Calls `visit` on every call expression under `value`. */
function eachCall(value: unknown, visit: (call: AstNode, args: unknown[]) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) eachCall(item, visit)
    return
  }
  if (!isNode(value)) return
  if (value.type === 'CallExpression') visit(value, Array.isArray(value.arguments) ? value.arguments : [])
  for (const [field, child] of Object.entries(value)) {
    if (field !== 'type' && typeof child === 'object') eachCall(child, visit)
  }
}

/**
 * Every `findBy*`, `findAllBy*`, `vi.waitFor` call in `source`, and every `waitFor` and
 * `waitForElementToBeRemoved` it imports from testing-library or `storybook/test`, with
 * whether it passes `WAIT` as its timeout. Parsed, not matched: a call in a comment or a
 * string is no call.
 */
export function findWaits(source: string, lang: 'ts' | 'tsx' = 'tsx'): Wait[] {
  return waitsOf(parseAst(source, { lang }), source)
}

function waitsOf(ast: unknown, source: string): Wait[] {
  const found: Wait[] = []
  const imports = waitImports(ast)
  eachCall(ast, (node, args) => {
    const call = waitCall(node.callee, imports)
    if (call === undefined) return
    const timeout: unknown = args[timeoutPosition(call)]
    found.push({
      line: lineAt(source, node.start),
      call,
      timed: isNode(timeout) && timeout.type === 'Identifier' && timeout.name === TIMEOUT,
    })
  })
  return found
}

function langOf(path: string): 'ts' | 'tsx' {
  return path.endsWith('x') ? 'tsx' : 'ts'
}

/** A test module read and parsed once: its waits, and whether it runs the guard. */
function readModule(dir: string, path: string): { waits: Wait[]; ast: unknown } {
  const source = readFileSync(resolve(dir, path), 'utf8')
  let ast: unknown
  try {
    ast = parseAst(source, { lang: langOf(path) })
  } catch (error) {
    throw new Error(`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { waits: waitsOf(ast, source), ast }
}

/**
 * The local names under which a module imports the guard from {@link GUARD_MODULE}:
 * the function itself (`import { assertWaitsDeclareTimeout as guard }`) and namespaces.
 */
function guardImports(ast: unknown): { functions: Set<string>; namespaces: Set<string> } {
  const functions = new Set<string>()
  const namespaces = new Set<string>()
  for (const { source, specifiers } of importsOf(ast)) {
    if (source !== GUARD_MODULE) continue
    for (const specifier of specifiers) {
      if (!isNode(specifier.local)) continue
      const local = String(specifier.local.name)
      if (specifier.type === 'ImportNamespaceSpecifier') namespaces.add(local)
      if (specifier.type === 'ImportSpecifier' && importedName(specifier) === GUARD) functions.add(local)
    }
  }
  return { functions, namespaces }
}

/**
 * Whether a call to `callee` runs the callback it is given: `it`, `test`, `describe`,
 * `suite` and the hooks, with `.only`, `.each(…)`, `.concurrent`…, but not `.skip`,
 * `.todo`, `.skipIf(…)`, `.runIf(…)` or `.fails`.
 */
function runsCallback(callee: unknown): boolean {
  let node = callee
  while (isNode(node)) {
    if (node.type === 'Identifier') return RUNS_CALLBACK.has(String(node.name))
    if (node.type === 'MemberExpression') {
      const name = propertyName(node)
      if (name === undefined || MAY_NOT_RUN.has(name)) return false
      node = node.object
    } else if (node.type === 'CallExpression') node = node.callee
    else return false
  }
  return false
}

/**
 * Whether the module runs the guard: a call to the function it imports from
 * {@link GUARD_MODULE}, at the top level of the module or in the callback of a test, a
 * suite or a hook that is not skipped. A call inside any other function is not counted,
 * since nothing proves that function is called.
 */
function runsGuard(ast: unknown): boolean {
  const { functions, namespaces } = guardImports(ast)
  if (functions.size === 0 && namespaces.size === 0) return false
  const isGuard = (callee: unknown) =>
    isNode(callee) &&
    ((callee.type === 'Identifier' && functions.has(String(callee.name))) ||
      (callee.type === 'MemberExpression' &&
        isNode(callee.object) &&
        callee.object.type === 'Identifier' &&
        namespaces.has(String(callee.object.name)) &&
        propertyName(callee) === GUARD))
  const walk = (value: unknown, live: boolean, run = false): boolean => {
    if (Array.isArray(value)) return value.some((item) => walk(item, live))
    if (!isNode(value)) return false
    const here = live && (run || !FUNCTION.has(value.type))
    if (value.type === 'CallExpression') {
      if (here && isGuard(value.callee)) return true
      const runs = runsCallback(value.callee)
      const args = Array.isArray(value.arguments) ? value.arguments : []
      return walk(value.callee, here) || args.some((arg) => walk(arg, here, runs))
    }
    return Object.entries(value).some(
      ([field, child]) => field !== 'type' && typeof child === 'object' && walk(child, here),
    )
  }
  return walk(ast, true)
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
export function assertWaitsDeclareTimeout(workspace: string, label = '.', options: WaitGuardOptions = {}): void {
  const files = testModules(workspace, options.ignore)
  if (files.length === 0) throw new Error(`assertWaitsDeclareTimeout: no test file found under ${label}`)
  const offenders = files.flatMap((path) =>
    readModule(workspace, path)
      .waits.filter((wait) => !wait.timed)
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
 * whose test modules wait (timed or not) has a spec or test that imports
 * `assertWaitsDeclareTimeout` from `@lntt/test-utils/waits` and calls it at its top level
 * or in a test, suite or hook callback that is not skipped, so a new package that waits
 * cannot skip the guard. It does not check the path the call is given, nor a condition
 * around it. A project whose workspaces do not wait passes; one with no test module
 * under its workspaces fails.
 */
export function assertWaitingWorkspacesRunTheGuard(root: string, options: WaitGuardOptions = {}): void {
  const found = workspaces(root)
  if (found.length === 0) {
    throw new Error(`assertWaitingWorkspacesRunTheGuard: no workspace found under apps/* or packages/* of ${root}`)
  }
  let scanned = 0
  const unguarded = found.flatMap((workspace) => {
    const dir = resolve(root, workspace)
    const modules = workspaceTestModules(root, workspace, options.ignore).map((path) => ({
      path,
      ...readModule(dir, path),
    }))
    scanned += modules.length
    const waiting = modules.filter(({ waits }) => waits.length > 0).map(({ path }) => path)
    if (waiting.length === 0) return []
    const guarded = modules.some(({ path, ast }) => TEST_FILE.test(path) && runsGuard(ast))
    return guarded ? [] : [`  - ${workspace} (${waiting.join(', ')})`]
  })
  if (scanned === 0) {
    throw new Error(`assertWaitingWorkspacesRunTheGuard: no test file found under apps/* or packages/* of ${root}`)
  }
  if (unguarded.length > 0) {
    throw new Error(
      `These workspaces wait in their tests but no test of theirs runs assertWaitsDeclareTimeout ` +
        `from ${GUARD_MODULE}:\n${unguarded.join('\n')}\n` +
        `Add a spec that imports it and calls it on the workspace in a test that is not skipped, ` +
        `so a wait without ${TIMEOUT} fails the workspace's own test task. ` +
        `See ${TEST_GUARDS_RECORD} (waits).`,
    )
  }
}
