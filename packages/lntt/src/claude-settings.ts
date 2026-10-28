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

// Runs before lntt can, so it is a shell line with no lntt and no jq. It never fails the
// session: when the install cannot run it says, once, what to run instead. The status
// message tells this hook from the project's own, so an older line is replaced.
export const INSTALL_HOOK = {
  type: 'command',
  command: [
    'cd "$CLAUDE_PROJECT_DIR" || exit 0',
    '[ -x node_modules/.bin/lntt ] && exit 0',
    "if [ -f package-lock.json ] && [ ! -f pnpm-lock.yaml ]; then c='npm ci'; m='npm ci'; else c='pnpm install --frozen-lockfile'; m='pnpm install'; fi",
    'if $c >/dev/null 2>&1 && [ -x node_modules/.bin/lntt ]; then printf \'{"systemMessage":"lntt was missing: the dependencies are installed (%s)"}\\n\' "$c"',
    'else printf \'{"systemMessage":"lntt is not installed and %s failed: run %s"}\\n\' "$c" "$m"; fi',
  ].join('; '),
  statusMessage: 'lntt: checking the dependencies are installed',
}

export interface SettingsEntry {
  key: string
  // `elsewhere`: the marketplace names another source; `off`: the plugin is disabled;
  // `edited`: the install hook differs from the one lntt writes; `invalid`: the file is
  // not JSON.
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

function load(file: string): { text: string; settings: Settings } | null {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '{}\n'
  const errors: jsonc.ParseError[] = []
  const settings = jsonc.parse(text, errors, { allowTrailingComma: true }) as Settings
  if (errors.length > 0 || typeof settings !== 'object' || settings === null || Array.isArray(settings)) return null
  return { text, settings }
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

// Writes the three entries, each only when it is off, with edits that keep the rest of
// the file as it is: the project's own hooks of SessionStart stay beside the install hook.
export function syncClaudeSettings(cwd: string): void {
  const file = join(projectRoot(cwd), SETTINGS)
  const loaded = load(file)
  if (loaded === null) throw new ConfigError(`${SETTINGS} is not JSON: fix it, then run lntt sync`)
  const [marketplace, plugin, hook] = entries(loaded.settings) as [SettingsEntry, SettingsEntry, SettingsEntry]
  const edits: [jsonc.JSONPath, unknown][] = []
  if (marketplace.state !== 'ok') edits.push([['extraKnownMarketplaces', 'lunette'], MARKETPLACE])
  if (plugin.state !== 'ok') edits.push([['enabledPlugins', PLUGIN], true])
  if (hook.state !== 'ok') {
    const kept = (loaded.settings.hooks?.SessionStart ?? [])
      .map((e) => ({ ...e, hooks: (e.hooks ?? []).filter((h) => !ours(h)) }))
      .filter((e) => e.hooks.length > 0)
    edits.push([
      ['hooks', 'SessionStart'],
      [...kept, { hooks: [INSTALL_HOOK] }],
    ])
  }
  if (edits.length === 0 && existsSync(file)) return
  let text = loaded.text
  for (const [path, value] of edits) {
    text = jsonc.applyEdits(
      text,
      jsonc.modify(text, path, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
    )
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`)
}
