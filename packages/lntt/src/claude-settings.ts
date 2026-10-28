// The entries of a project's `.claude/settings.json` that come with lntt
// (docs/adr/agent-layer.md#where-hooks-live): the Lunette plugin, loaded from the
// `directory` marketplace this package ships at its root, the hook that installs the
// dependencies when lntt itself is missing, and the lines of `lntt hook format` and
// `lntt hook typecheck` (./hook.ts). `lntt sync` writes them and keeps whatever else the
// file holds; `lntt check plugin` says when they are missing or point elsewhere.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as jsonc from 'jsonc-parser'
import { ConfigError } from './files.ts'
import { findConfig } from './index.ts'

export const SETTINGS = '.claude/settings.json'

// A relative path resolves against the main checkout, from any worktree: the plugin is
// the one the main checkout installed.
export const MARKETPLACE = { source: { source: 'directory', path: './node_modules/@lntt/lntt' } }
export const PLUGIN = 'lunette@lunette'

// Runs before lntt can, so it is a shell line with no lntt and no jq. It installs with pnpm
// (a Lunette project's manager), or `npm ci` in a project that has only a package-lock.json.
// It never fails the session: when the install cannot run it says, once, what to run
// instead. Its timeout leaves room for a cold install. The status message tells this hook
// from the project's own, so an older line is replaced.
export const INSTALL_HOOK = {
  type: 'command',
  command: [
    'cd "$CLAUDE_PROJECT_DIR" || exit 0',
    '[ -x node_modules/.bin/lntt ] && exit 0',
    "if [ -f package-lock.json ] && [ ! -f pnpm-lock.yaml ]; then c='npm ci'; m='npm ci'; else c='pnpm install --frozen-lockfile'; m='pnpm install'; fi",
    'if $c >/dev/null 2>&1 && [ -x node_modules/.bin/lntt ]; then printf \'{"systemMessage":"lntt was missing: the dependencies are installed (%s)"}\\n\' "$c"',
    'else printf \'{"systemMessage":"lntt is not installed and %s failed: run %s"}\\n\' "$c" "$m"; fi',
  ].join('; '),
  timeout: 600,
  statusMessage: 'lntt: checking the dependencies are installed',
}

// The first @lntt/lntt with `lntt hook`.
export const HOOK_SINCE = '0.6.3'

// A thin line: the logic is in `lntt hook <name>`. With lntt missing it says nothing: the
// install hook says that at the session start. An lntt with no `hook` command answers with
// its usage, exit 2: the line says once per session (per Claude Code process) what to run.
// `lntt hook` exits 1 for a failure to report, which the line turns into the exit 2 that
// wakes the agent where `wake` asks it.
function hookLine(name: string, wake: boolean): string {
  return [
    'cd "$CLAUDE_PROJECT_DIR" || exit 0',
    '[ -x node_modules/.bin/lntt ] || exit 0',
    `node_modules/.bin/lntt hook ${name}`,
    's=$?',
    `[ $s -eq 1 ] && exit ${wake ? 2 : 0}`,
    '[ $s -eq 2 ] || exit 0',
    `t="\${TMPDIR:-/tmp}/lntt-hook-${name}-$PPID"`,
    '[ -f "$t" ] && exit 0',
    ': > "$t"',
    `printf '{"systemMessage":"this lntt has no lntt hook, which came with @lntt/lntt ${HOOK_SINCE}: run pnpm up @lntt/lntt"}\\n'`,
  ].join('; ')
}

export const FORMAT_HOOK = {
  type: 'command',
  command: hookLine('format', false),
  timeout: 120,
  statusMessage: 'lntt: formatting the file written',
}

export const TYPECHECK_HOOK = {
  type: 'command',
  command: hookLine('typecheck', true),
  asyncRewake: true,
  rewakeSummary: 'Typecheck failed',
  timeout: 900,
  statusMessage: 'lntt: typecheck',
}

// Each hook lntt writes: its event, the matcher of its entry, and how check names it.
const HOOKS = [
  { event: 'SessionStart', hook: INSTALL_HOOK, label: 'install' },
  { event: 'PostToolUse', matcher: 'Write|Edit', hook: FORMAT_HOOK, label: 'format' },
  { event: 'Stop', hook: TYPECHECK_HOOK, label: 'typecheck' },
] as const
type Placed = (typeof HOOKS)[number]
export const HOOK_LABELS: Record<string, string> = Object.fromEntries(HOOKS.map((h) => [`hooks.${h.event}`, h.label]))

export interface SettingsEntry {
  key: string
  // `elsewhere`: the marketplace names another source; `off`: the plugin is disabled;
  // `edited`: a hook lntt writes differs from the one it writes now; `invalid`: the file is
  // not JSON, or a key it reads does not have the shape Claude Code reads.
  state: 'ok' | 'missing' | 'elsewhere' | 'off' | 'edited' | 'invalid'
}

interface Hook {
  type?: string
  command?: string
  statusMessage?: string
}
interface HookEntry {
  matcher?: string
  hooks?: Hook[]
}
interface Settings {
  extraKnownMarketplaces?: Record<string, unknown>
  enabledPlugins?: Record<string, unknown>
  hooks?: Record<string, HookEntry[]>
}

function projectRoot(cwd: string): string {
  return dirname(dirname(findConfig(cwd).path))
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// The keys lntt reads and writes, in the shape Claude Code reads: objects, and each event
// of its hooks a list of entries each with a list of hooks.
function wellShaped(s: Record<string, unknown>): boolean {
  for (const key of ['extraKnownMarketplaces', 'enabledPlugins', 'hooks']) {
    if (s[key] !== undefined && !isObject(s[key])) return false
  }
  return HOOKS.every(({ event }) => {
    const list = (s.hooks as Record<string, unknown> | undefined)?.[event]
    if (list === undefined) return true
    if (!Array.isArray(list)) return false
    return list.every(
      (e) => isObject(e) && (e.hooks === undefined || (Array.isArray(e.hooks) && e.hooks.every(isObject))),
    )
  })
}

function load(file: string): { text: string; settings: Settings } | null {
  // A byte order mark some editors write is no part of the JSON.
  const text = existsSync(file) ? readFileSync(file, 'utf8').replace(/^\uFEFF/, '') : '{}\n'
  const errors: jsonc.ParseError[] = []
  const settings = jsonc.parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !isObject(settings) || !wellShaped(settings)) return null
  return { text, settings: settings as Settings }
}

// A hook lntt wrote, at any version: told by its status message.
const ours = (placed: Placed) => (h: Hook) => h.statusMessage === placed.hook.statusMessage
// Equal values, whatever the order of their keys.
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : isObject(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

// Ok: one hook of lntt's, the one it writes now, in an entry of the matcher it writes.
function hookState(settings: Settings, placed: Placed): SettingsEntry['state'] {
  const holding = (settings.hooks?.[placed.event] ?? []).filter((e) => (e.hooks ?? []).some(ours(placed)))
  const found = holding.flatMap((e) => (e.hooks ?? []).filter(ours(placed)))
  if (found.length === 0) return 'missing'
  const matcher = 'matcher' in placed ? placed.matcher : undefined
  return found.length === 1 && same(found[0], placed.hook) && holding[0]?.matcher === matcher ? 'ok' : 'edited'
}

function entries(settings: Settings): SettingsEntry[] {
  const marketplace = settings.extraKnownMarketplaces?.lunette
  const plugin = settings.enabledPlugins?.[PLUGIN]
  return [
    {
      key: 'extraKnownMarketplaces.lunette',
      state: marketplace === undefined ? 'missing' : same(marketplace, MARKETPLACE) ? 'ok' : 'elsewhere',
    },
    { key: `enabledPlugins.${PLUGIN}`, state: plugin === undefined ? 'missing' : plugin === true ? 'ok' : 'off' },
    ...HOOKS.map((placed) => ({ key: `hooks.${placed.event}`, state: hookState(settings, placed) })),
  ]
}

export function checkClaudeSettings(cwd: string): SettingsEntry[] {
  const loaded = load(join(projectRoot(cwd), SETTINGS))
  if (loaded === null) return [{ key: SETTINGS, state: 'invalid' }]
  return entries(loaded.settings)
}

export const INVALID = `${SETTINGS} is not JSON, or not the shape Claude Code reads: fix it, then run lntt sync`

const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2 } }

// One edit, applied to the text: undefined removes the value at the path.
function edit(text: string, path: jsonc.JSONPath, value: unknown, insert = false): string {
  return jsonc.applyEdits(text, jsonc.modify(text, path, value, { ...FORMAT, isArrayInsertion: insert }))
}

// Each hook of this kind lntt wrote, removed from the last one up so the indexes before it
// hold (an entry left with no hook goes with it), then the one lntt writes now appended:
// the project's own entries, their comments and formatting stay as they are.
function placeHook(text: string, list: HookEntry[] | undefined, placed: Placed): string {
  const entry = { ...('matcher' in placed ? { matcher: placed.matcher } : {}), hooks: [placed.hook] }
  if (list === undefined) return edit(text, ['hooks', placed.event], [entry])
  const mine = ours(placed)
  let next = text
  let length = list.length
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const hooks = list[i]?.hooks ?? []
    if (!hooks.some(mine)) continue
    if (hooks.every(mine)) {
      next = edit(next, ['hooks', placed.event, i], undefined)
      length -= 1
      continue
    }
    for (let j = hooks.length - 1; j >= 0; j -= 1) {
      if (mine(hooks[j] as Hook)) next = edit(next, ['hooks', placed.event, i, 'hooks', j], undefined)
    }
  }
  return edit(next, ['hooks', placed.event, length], entry, true)
}

// Writes the entries, each only when it is off, with edits that keep the rest of the file
// as it is: the project's own hooks of each event stay beside lntt's.
export function syncClaudeSettings(cwd: string): void {
  const file = join(projectRoot(cwd), SETTINGS)
  const loaded = load(file)
  if (loaded === null) throw new ConfigError(INVALID)
  const [marketplace, plugin, ...hooks] = entries(loaded.settings) as SettingsEntry[]
  let text = loaded.text
  if (marketplace?.state !== 'ok') text = edit(text, ['extraKnownMarketplaces', 'lunette'], MARKETPLACE)
  if (plugin?.state !== 'ok') text = edit(text, ['enabledPlugins', PLUGIN], true)
  HOOKS.forEach((placed, i) => {
    if (hooks[i]?.state !== 'ok') text = placeHook(text, loaded.settings.hooks?.[placed.event], placed)
  })
  if (text === loaded.text && existsSync(file)) return
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`)
}
