import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { globSync } from 'glob'
import { blankComments, blankCommentsAndStrings } from './source-scan.ts'

/**
 * Three rules over the containers a project's tests start, for its `apps/*` and
 * `packages/*`. Each one keeps a container from outliving its run, and none of them
 * fails a test by itself when broken: a forgotten plugin is a database suite that
 * rejects, or skips and goes green on nothing; a disabled reaper or a missing label is
 * a container found days later.
 *
 * The rules read source text, not a syntax tree, through the blanker of
 * `source-scan.ts`, which knows comments and string and template literals and nothing
 * else. A quote or a `/*` inside a regular expression literal (`/'/`, `/a/*b/`) or in
 * JSX text (`<p>don't</p>`) opens a string or a comment the code never opened, and
 * what follows in that file is blanked or kept wrongly until the scan resyncs: a
 * violation there can pass, and a correct line can fail. Move such a literal to a
 * file of its own, or spell it another way (`new RegExp("'")`, `{"don't"}`).
 */

/**
 * `nodir`: a name matching `*.tsx` is not proof of a file. Vitest's visual suite writes
 * screenshots into a DIRECTORY named after the spec, and reading it dies with EISDIR.
 */
const NOT_SOURCE = ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.react-router/**', '**/__screenshots__/**']

/** Every source a test can start or configure a container from, configs included. */
const SOURCES = '**/*.{ts,tsx,mts,cts,js,mjs,cjs}'

/** What uses the test database. Matched on code only, comments and strings blanked. */
const USES_TEST_DB = /\b(createTestDb|withTestDb)\b/

/** A vitest config must CALL the plugin, not merely import or mention it. */
const MOUNTS_PLUGIN = /\btestDbPlugin\s*\(/

/**
 * Code that SETS `TESTCONTAINERS_RYUK_DISABLED`, the variable that turns Ryuk, the
 * testcontainers reaper, off. Either an assignment: the name, an optional closing quote
 * and bracket, then `=`, `??=`, `||=` or `&&=` (not `==` or `===`), as in `process.env.NAME = …`,
 * `process.env['NAME'] = …` and a string `'NAME=1 vitest'`. Or an object key: the name,
 * quoted or not, right after a `{` or `,` (newlines allowed), then `:`, as in
 * `{ NAME: … }` and `{ CI: '1', 'NAME': … }`. Not a read (`if (process.env.NAME)`, `c ?
 * process.env.NAME : x`), a comparison, or a test that the name is absent
 * (`toHaveProperty('NAME')`). A type literal reads as an object key: one whose type is
 * `string`, `boolean` or `undefined` is skipped, any other (`{ NAME: 'true' }`) is
 * reported outside declaration files.
 */
const SETS_RYUK_DISABLED =
  /\bTESTCONTAINERS_RYUK_DISABLED['"`]?\]?\s*(?:\?\?|\|\||&&)?=(?!=)|(?<=[{,]\s*)(['"`]?)TESTCONTAINERS_RYUK_DISABLED\1\s*:(?!\s*(?:string|boolean|undefined)\b)/g

/** A shell script that sets it: `NAME=1 cmd`, `cross-env NAME=1 cmd`, `export NAME`. */
const SCRIPT_SETS_RYUK_DISABLED = /\bTESTCONTAINERS_RYUK_DISABLED=|\bexport\s+TESTCONTAINERS_RYUK_DISABLED\b/

/** Declaration files type the variable (`NAME?: string`) and set nothing. */
const DECLARATIONS = ['**/*.d.ts', '**/*.d.mts', '**/*.d.cts']

/** Generic arguments, `<Record<string, string>>`, up to the parenthesis they precede. */
const TYPE_ARGUMENTS = String.raw`(?:<[^()]*>\s*)?`

/** A container constructed directly, up to its opening parenthesis. */
const NEW_CONTAINER = new RegExp(String.raw`\bnew\s+(GenericContainer|PostgreSqlContainer)\s*${TYPE_ARGUMENTS}\(`, 'g')

/**
 * One link of a builder chain after a call, up to its opening parenthesis, whitespace
 * and newlines allowed: `.method(`, `?.method(`, `!.method(` after a non-null
 * assertion, `.method<T>(`.
 */
const CHAIN_LINK = new RegExp(String.raw`^\s*(?:!\s*)*\??\.\s*([A-Za-z_$][\w$]*)\s*${TYPE_ARGUMENTS}\(`)

/** Where a rule was broken, relative to the project root. */
export interface SourceLocation {
  /** The file, relative to the root: `packages/db/src/repo.test.ts`. */
  file: string
  /** 1-based. */
  line: number
}

export interface TestDbUser {
  /** The workspace, relative to the root: `apps/web`, `packages/db`. */
  name: string
  /** Whether one of its `vitest*.config.*` files calls `testDbPlugin()`. */
  mountsPlugin: boolean
}

export interface ContainerRuleOptions {
  /**
   * Label constants a container chain may name besides `WORKSPACE_LABEL`, such as the
   * label an e2e setup stamps on what it starts. Identifiers, as the code spells them.
   */
  labels?: string[]
}

function workspaces(root: string): string[] {
  return globSync(['apps/*/', 'packages/*/'], { cwd: root })
    .map((name) => name.replace(/\/$/, ''))
    .filter((name) => existsSync(resolve(root, name, 'package.json')))
    .sort()
}

/** Every source file of every workspace, absolute, sorted. */
function sources(root: string, ignore: string[] = []): string[] {
  return workspaces(root)
    .flatMap((name) =>
      globSync(SOURCES, { cwd: resolve(root, name), absolute: true, nodir: true, ignore: [...NOT_SOURCE, ...ignore] }),
    )
    .sort()
}

function code(file: string): string {
  return blankCommentsAndStrings(readFileSync(file, 'utf8'))
}

function lineAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++
  return line
}

function located(root: string, file: string, line: number): SourceLocation {
  return { file: relative(root, file), line }
}

function byLocation(a: SourceLocation, b: SourceLocation): number {
  return a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line
}

/**
 * Every workspace whose code uses the test database (`createTestDb`, `withTestDb`;
 * comments and strings blanked, so one that merely talks about them is not taken for
 * a user), and whether a vitest config of it mounts `testDbPlugin()`. Without the
 * plugin there is no server: `createTestDb` starts none, so its database suites
 * reject, or skip on `hasTestDatabase()` and go green on nothing. A
 * workspace that starts other containers, `postgresContainer()` included, needs no
 * plugin: it stops them itself, and Ryuk removes them when a run is killed.
 */
export function testDbUsers(root: string): TestDbUser[] {
  return workspaces(root).flatMap((name) => {
    const dir = resolve(root, name)
    const files = globSync(SOURCES, { cwd: dir, absolute: true, nodir: true, ignore: NOT_SOURCE })
    if (!files.some((file) => USES_TEST_DB.test(code(file)))) return []
    const configs = globSync('vitest*.config.{ts,mts,cts,js,mjs,cjs}', { cwd: dir, absolute: true, nodir: true })
    return [{ name, mountsPlugin: configs.some((file) => MOUNTS_PLUGIN.test(code(file))) }]
  })
}

/**
 * Every place that SETS `TESTCONTAINERS_RYUK_DISABLED` (an assignment or an object key):
 * sources (vitest configs and globalSetup files included, declaration files not) with
 * comments blanked but strings KEPT, so `process.env['TESTCONTAINERS_RYUK_DISABLED'] =
 * '1'` and `env: { 'TESTCONTAINERS_RYUK_DISABLED': 'true' }` both count; and the
 * `scripts` of the root's and each workspace's `package.json` that assign or export it,
 * each on the line of its value as `JSON.stringify` spells it, searched from the
 * `"scripts"` key on; a value the file spells with other escapes (`\/`, `\u0072`) is
 * reported on line 1.
 * Code that reads the variable, or checks that it is absent, is not reported. Ryuk is
 * what removes a `SIGKILL`ed run's containers; a machine that cannot run it sets the
 * variable in its own shell, never in the project.
 *
 * Throws, naming the file, on a `package.json` that is not valid JSON or not an object.
 */
export function ryukDisablers(root: string): SourceLocation[] {
  const found: SourceLocation[] = []
  for (const file of sources(root, DECLARATIONS)) {
    const text = blankComments(readFileSync(file, 'utf8'))
    for (const match of text.matchAll(SETS_RYUK_DISABLED)) found.push(located(root, file, lineAt(text, match.index)))
  }
  for (const dir of ['.', ...workspaces(root)]) {
    const file = resolve(root, dir, 'package.json')
    if (!existsSync(file)) continue
    const raw = readFileSync(file, 'utf8')
    let manifest: unknown
    try {
      manifest = JSON.parse(raw)
    } catch (error) {
      throw new Error(`${relative(root, file)} is not valid JSON: ${(error as Error).message}`)
    }
    // `null`, a string or an array parse too, and have no `scripts` to read.
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
      throw new Error(`${relative(root, file)} is not a JSON object`)
    }
    const { scripts } = manifest as { scripts?: Record<string, unknown> }
    for (const script of Object.values(scripts ?? {})) {
      if (typeof script !== 'string' || !SCRIPT_SETS_RYUK_DISABLED.test(script)) continue
      const at = raw.indexOf(JSON.stringify(script), raw.indexOf('"scripts"'))
      found.push(located(root, file, at === -1 ? 1 : lineAt(raw, at)))
    }
  }
  return found.sort(byLocation)
}

/** The index just past the parenthesis that closes the one at `open`, or -1. */
function closing(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return i + 1
  }
  return -1
}

/**
 * Every `new GenericContainer(` and `new PostgreSqlContainer(` (comments and strings
 * blanked) whose chain has no `.withLabels(…)` with a label constant as a COMPUTED key:
 * `.withLabels({ [WORKSPACE_LABEL]: workspaceRoot() })`, `WORKSPACE_LABEL` or a
 * constant of `options.labels`. `{ WORKSPACE_LABEL: … }` (the brackets forgotten, so
 * the key is the text `WORKSPACE_LABEL`), the constant as a value, or the constant in
 * another call labels nothing with it, and is reported. The chain is the constructor
 * call followed by every `.method(…)` call written after it, across lines, `?.`, `!`
 * and generic arguments included. The label is what lets `lntt-clean-test` find what
 * Ryuk misses (containers left exited after the Docker daemon restarted, a run with
 * Ryuk disabled in its shell) without touching other projects' containers.
 *
 * Only these two classes are checked: a container of another testcontainers module
 * class (`new RedisContainer(…)`) is not read, labelled or not.
 *
 * Only the chain and the literal key are read, so these fail the rule although they
 * may label: a container labelled later through a variable (`const c = new
 * GenericContainer(…)`, then `c.withLabels(…)`), labels spread from an object
 * (`.withLabels({ ...labels })`), and a chain broken by an `as` cast
 * (`(new GenericContainer(…) as T).withLabels(…)`). Label it in the chain, with the
 * constant as the key.
 */
export function unlabelledContainers(root: string, options: ContainerRuleOptions = {}): SourceLocation[] {
  const constants = ['WORKSPACE_LABEL', ...(options.labels ?? [])].map((name) =>
    name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  )
  const namesALabel = new RegExp(String.raw`\[\s*(?:${constants.join('|')})\s*\]\s*:`)
  const found: SourceLocation[] = []
  for (const file of sources(root)) {
    const text = code(file)
    for (const match of text.matchAll(NEW_CONTAINER)) {
      let end = closing(text, match.index + match[0].length - 1)
      let labelled = false
      while (end !== -1) {
        const link = CHAIN_LINK.exec(text.slice(end))
        if (!link) break
        const open = end + link[0].length - 1
        const next = closing(text, open)
        if (link[1] === 'withLabels' && next !== -1 && namesALabel.test(text.slice(open, next))) labelled = true
        end = next
      }
      if (!labelled) found.push(located(root, file, lineAt(text, match.index)))
    }
  }
  return found.sort(byLocation)
}

/**
 * The rules that arm themselves: {@link testDbUsers} must mount `testDbPlugin()`, no
 * source may set `TESTCONTAINERS_RYUK_DISABLED` ({@link ryukDisablers}), and every
 * container must be labelled in its chain ({@link unlabelledContainers}). Throws once,
 * listing every violation under its rule with what to do.
 *
 * @example
 * ```ts
 * // meta-containers.spec.ts, at a place that knows the project root
 * it('every container the tests start can be cleaned up', () => {
 *   assertContainerRules(resolve(__dirname, '../../..'))
 * })
 * ```
 */
export function assertContainerRules(root: string, options: ContainerRuleOptions = {}): void {
  const list = (items: string[]) => items.map((item) => `  - ${item}`).join('\n')
  const at = (locations: SourceLocation[]) => list(locations.map(({ file, line }) => `${file}:${line}`))
  const sections: string[] = []

  const missing = testDbUsers(root).filter((user) => !user.mountsPlugin)
  if (missing.length > 0) {
    sections.push(
      'These workspaces use the test database (createTestDb, withTestDb) without a vitest config that ' +
        `calls testDbPlugin():\n${list(missing.map((user) => user.name))}\n` +
        "  Mount testDbPlugin() from '@lntt/test-utils/plugin' in their vitest.config.ts.",
    )
  }
  const disablers = ryukDisablers(root)
  if (disablers.length > 0) {
    sections.push(
      `These places set TESTCONTAINERS_RYUK_DISABLED (an assignment or an object key):\n${at(disablers)}\n` +
        '  Remove the assignment: Ryuk removes the containers of a killed run. Set it only in your own ' +
        'shell, on a machine that cannot run Ryuk.',
    )
  }
  const unlabelled = unlabelledContainers(root, options)
  if (unlabelled.length > 0) {
    const accepted = ['WORKSPACE_LABEL', ...(options.labels ?? [])].join(', ')
    sections.push(
      `These containers carry no label constant (${accepted}) as a computed key of .withLabels() in their chain:\n${at(unlabelled)}\n` +
        "  Add .withLabels({ [WORKSPACE_LABEL]: workspaceRoot() }) to the chain, from '@lntt/test-utils/workspace'.",
    )
  }
  if (sections.length > 0) throw new Error(`Container rules broken under ${root}:\n\n${sections.join('\n\n')}`)
}
