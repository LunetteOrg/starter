// The entries of a project's `.claude/settings.json` that come with lntt
// (docs/adr/agent-layer.md#where-hooks-live): the Lunette plugin, loaded from the
// `directory` marketplace this package ships at its root, and the hook that installs the
// dependencies when lntt itself is missing. `lntt sync` writes them and keeps whatever
// else the file holds; `lntt check plugin` says when they are missing or point elsewhere.

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

export interface SettingsEntry {
  key: string
  // `elsewhere`: the marketplace names another source; `off`: the plugin is disabled;
  // `edited`: the install hook differs from the one lntt writes; `invalid`: the file is
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

// The keys lntt reads and writes, in the shape Claude Code reads: objects, and SessionStart
// a list of entries each with a list of hooks.
function wellShaped(s: Record<string, unknown>): boolean {
  for (const key of ['extraKnownMarketplaces', 'enabledPlugins', 'hooks']) {
    if (s[key] !== undefined && !isObject(s[key])) return false
  }
  const start = (s.hooks as Record<string, unknown> | undefined)?.SessionStart
  if (start === undefined) return true
  if (!Array.isArray(start)) return false
  return start.every(
    (e) => isObject(e) && (e.hooks === undefined || (Array.isArray(e.hooks) && e.hooks.every(isObject))),
  )
}

function load(file: string): { text: string; settings: Settings } | null {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '{}\n'
  const errors: jsonc.ParseError[] = []
  const settings = jsonc.parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !isObject(settings) || !wellShaped(settings)) return null
  return { text, settings: settings as Settings }
}

const ours = (h: Hook) => h.statusMessage === INSTALL_HOOK.statusMessage
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function hookState(settings: Settings): SettingsEntry['state'] {
  const hooks = (settings.hooks?.SessionStart ?? []).flatMap((e) => e.hooks ?? [])
  const found = hooks.filter(ours)
  if (found.length === 0) return 'missing'
  return found.length === 1 && same(found[0], INSTALL_HOOK) ? 'ok' : 'edited'
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
    { key: 'hooks.SessionStart', state: hookState(settings) },
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

// Each install hook lntt wrote, removed from the last one up so the indexes before it
// hold (an entry left with no hook goes with it), then the one lntt writes now appended:
// the project's own entries, their comments and formatting stay as they are.
function placeInstallHook(text: string, start: HookEntry[] | undefined): string {
  if (start === undefined) return edit(text, ['hooks', 'SessionStart'], [{ hooks: [INSTALL_HOOK] }])
  let next = text
  let length = start.length
  for (let i = start.length - 1; i >= 0; i -= 1) {
    const hooks = start[i]?.hooks ?? []
    if (!hooks.some(ours)) continue
    if (hooks.every(ours)) {
      next = edit(next, ['hooks', 'SessionStart', i], undefined)
      length -= 1
      continue
    }
    for (let j = hooks.length - 1; j >= 0; j -= 1) {
      if (ours(hooks[j] as Hook)) next = edit(next, ['hooks', 'SessionStart', i, 'hooks', j], undefined)
    }
  }
  return edit(next, ['hooks', 'SessionStart', length], { hooks: [INSTALL_HOOK] }, true)
}

// Writes the three entries, each only when it is off, with edits that keep the rest of
// the file as it is: the project's own hooks of SessionStart stay beside the install hook.
export function syncClaudeSettings(cwd: string): void {
  const file = join(projectRoot(cwd), SETTINGS)
  const loaded = load(file)
  if (loaded === null) throw new ConfigError(INVALID)
  const [marketplace, plugin, hook] = entries(loaded.settings) as [SettingsEntry, SettingsEntry, SettingsEntry]
  let text = loaded.text
  if (marketplace.state !== 'ok') text = edit(text, ['extraKnownMarketplaces', 'lunette'], MARKETPLACE)
  if (plugin.state !== 'ok') text = edit(text, ['enabledPlugins', PLUGIN], true)
  if (hook.state !== 'ok') text = placeInstallHook(text, loaded.settings.hooks?.SessionStart)
  if (text === loaded.text && existsSync(file)) return
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`)
}
