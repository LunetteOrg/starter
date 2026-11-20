// `lntt dump`: the environment a report on Lunette itself needs (lntt issue), collected by
// a command instead of by hand, and redacted before anyone sends it: the lntt version and
// how it is installed, Node, the package manager and the OS, the harness and the model,
// the project's configuration, skills, hooks and Lunette packages, and the failing command
// with its output when there is one. The operator reads the whole dump before it leaves
// the machine (lntt issue sends nothing without --send).
//
// Plain logic, on the facts src/dump/collect.ts gathers from the machine.

import { parseDocument } from 'yaml'

export interface DumpSection {
  title: string
  // One fact per line; a fenced block (``` … ```) is kept as it is.
  lines: string[]
}

export interface Dump {
  sections: DumpSection[]
  // The fields of the issue template, as the Harness section has them.
  harness: string
  model: string
  lntt: string
  // The configuration's error when it does not validate: the dump reports it and lntt
  // dump exits 1 after printing it.
  configError?: string
}

export interface FailedCommand {
  argv: string[]
  status: number | null
  output: string
  // Why it has no exit code: stopped at the timeout, its output past the buffer, a signal.
  stopped?: string
}

type Env = Record<string, string | undefined>

// What the project holds that a dump reports, as src/dump/collect.ts read it.
export interface ProjectFacts {
  // Its package.json, null when there is none or it is not JSON.
  pkg: Record<string, unknown> | null
  // The lockfiles of LOCKS present at its root.
  locks: string[]
  // The folders of each skill directory, sorted.
  skills: { dir: string; names: string[] }[]
  // The text of its lefthook configuration, null without one.
  lefthook: string | null
  // Its .claude/settings.json, null when there is none or it is not JSON.
  claude: Record<string, unknown> | null
  // The version installed of each @lntt package it declares, null when not installed.
  installed: Record<string, string | null>
  // Its configuration: the file and its data, none (the defaults), or why it does not validate.
  config: { path: string; data: Record<string, unknown> } | { none: string } | { invalid: string }
}

// Everything a dump reports, gathered from the machine.
export interface DumpFacts {
  root: string
  env: Env
  // Given by the agent, which knows them better than the environment does.
  harness?: string
  model?: string
  // The version of the harness detected, null when none is or its --version does not run.
  harnessVersion: string | null
  // lntt's version and the directory of its package.json.
  lntt: { version: string; dir: string }
  // Node's version (`v24.1.0`) and the OS (`Darwin 27.0.0 arm64`).
  node: string
  os: string
  home: string
  // The project's git remotes, written as git prints them.
  remotes: string[]
  project: ProjectFacts
  command?: FailedCommand
}

// The output of the failing command keeps its last lines: the error is at the end.
const OUTPUT_LINES = 200

const HARNESSES: { name: string; command: string; when: (env: Record<string, string | undefined>) => boolean }[] = [
  { name: 'Claude Code', command: 'claude', when: (env) => env.CLAUDECODE === '1' },
  { name: 'Codex', command: 'codex', when: (env) => Object.keys(env).some((k) => k.startsWith('CODEX_')) },
  { name: 'OpenCode', command: 'opencode', when: (env) => env.OPENCODE === '1' },
]

export function detectHarness(env: Record<string, string | undefined>): string | null {
  return HARNESSES.find((h) => h.when(env))?.name ?? null
}

// The command whose --version names the harness detected, null when none is.
export function harnessCommand(env: Record<string, string | undefined>): string | null {
  return HARNESSES.find((h) => h.when(env))?.command ?? null
}

// Where this lntt runs from, seen from the project's root.
export function installKind(packageDir: string, root: string): string {
  if (packageDir.includes('/_npx/')) return 'npx'
  if (packageDir.includes('/node_modules/')) {
    return packageDir.startsWith(`${root}/`) ? 'a dependency of the project' : 'outside the project (global)'
  }
  return 'from source (a workspace package)'
}

// The version a `--version` prints: the first version-looking word of its first line, else the
// line; null when it printed nothing.
export function versionIn(stdout: string): string | null {
  const first = stdout.trim().split('\n')[0] ?? ''
  return /\d+\.\d+[\w.+-]*/.exec(first)?.[0] ?? (first || null)
}

// The names of the environment variables whose values are secrets wherever they appear;
// a value under 8 characters is left alone, since replacing it everywhere would garble
// the dump.
const SECRET_NAME = /token|secret|password|passwd|api_?key|credential|private_?key|auth/i

export function environmentSecrets(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && value !== undefined && value.length >= 8)
    .map(([, value]) => value as string)
}

export interface Redaction {
  home: string
  // The project's git remotes, written as git prints them.
  remotes: string[]
  // Literal values to hide wherever they appear (the environment's secrets).
  secrets: string[]
}

const TOKENS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_\w{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[\w-]{35}/g,
  /\bnpm_[A-Za-z0-9]{36}/g,
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g,
]
// A key that names a secret, then its value: quoted, or up to a space, a comma or a brace.
const SECRET_VALUE =
  /(\w*(?:token|secret|password|passwd|api_?key|credential)s?\w*)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi

export function redact(text: string, { home, remotes, secrets }: Redaction): string {
  let out = text
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) out = out.replaceAll(secret, '<redacted>')
  out = out.replace(/\b[a-z][\w+.-]*:\/\/[^\s/@'"]+@[^\s'"]+/gi, '<url with credentials>')
  // A remote that is a URL or an absolute path: a relative one (`.`, `../x`) replaced
  // everywhere would garble the text.
  for (const remote of remotes)
    if (remote.includes(':') || remote.startsWith('/')) out = out.replaceAll(remote, '<remote>')
  out = out.replace(/\b[\w.-]+@(?:[\w-]+\.)+[A-Za-z]{2,}:[\w./~-]+/g, '<remote>')
  out = out.replace(/\bBearer\s+\S+/g, 'Bearer <token>')
  for (const token of TOKENS) out = out.replace(token, '<token>')
  out = out.replace(SECRET_VALUE, (match, key: string, between: string, value: string) => {
    if (/^\d+$/.test(value) || value.startsWith('<')) return match
    const quote = /^["']/.test(value) ? value[0] : ''
    return `${key}${between}${quote}<redacted>${quote}`
  })
  // A domain ends in letters: `pnpm@10.16.1` is a version, not an address.
  out = out.replace(/[\w.+-]+@(?:[\w-]+\.)+[A-Za-z]{2,}\b/g, '<email>')
  if (home !== '' && home !== '/') {
    const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`${escaped}(?=/|$|[^\\w.-])`, 'g'), '~')
  }
  return out
}

// What is hidden in everything a report sends: the dump, and the draft beside it.
export function redactionOf(home: string, remotes: string[], env: Env): Redaction {
  return { home, remotes, secrets: environmentSecrets(env) }
}

// The remotes of `git remote -v`, once each.
export function remotesIn(output: string): string[] {
  return [...new Set(output.split('\n').map((l) => l.split(/\s+/)[1] ?? ''))].filter((r) => r !== '')
}

// The lockfiles a dump looks for, and the manager each names.
export const LOCKS: [string, string][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['package-lock.json', 'npm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
]

// The lefthook configurations a dump looks for, in order.
export const LEFTHOOKS = ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml']

function packageManager(pkg: Record<string, unknown> | null, locks: string[]): string {
  if (typeof pkg?.packageManager === 'string') return pkg.packageManager.replace(/\+sha\d+\..*$/, '')
  return LOCKS.find(([file]) => locks.includes(file))?.[1] ?? 'unknown'
}

// The @lntt packages a package.json declares, by name, with their ranges.
export function lnttPackages(pkg: Record<string, unknown> | null): Record<string, string> {
  const declared: Record<string, string> = {}
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, range] of Object.entries((pkg?.[field] ?? {}) as Record<string, string>)) {
      if (name.startsWith('@lntt/')) declared[name] = range
    }
  }
  return declared
}

function projectLines(root: string, facts: ProjectFacts): { lines: string[]; configError?: string } {
  const lines: string[] = []
  const skills = facts.skills
    .filter(({ names }) => names.length > 0)
    .map(({ dir, names }) => `${dir}: ${names.join(', ')}`)
  lines.push(`skills: ${skills.length > 0 ? skills.join('; ') : 'none'}`)

  if (facts.lefthook !== null) {
    const data = parseDocument(facts.lefthook).toJS() as Record<string, unknown> | null
    const hooks = Object.entries(data ?? {})
      .filter(([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v))
      .map(([k]) => k)
      .sort()
    lines.push(`git hooks (lefthook): ${hooks.join(', ') || 'none'}`)
  }
  const claude = facts.claude
  if (claude) {
    lines.push(`agent hooks (.claude/settings.json): ${Object.keys(claude.hooks ?? {}).join(', ') || 'none'}`)
    const plugins = Object.entries((claude.enabledPlugins ?? {}) as Record<string, boolean>)
      .filter(([, on]) => on)
      .map(([name]) => name)
    lines.push(`plugins: ${plugins.join(', ') || 'none'}`)
  }

  const packages = Object.entries(lnttPackages(facts.pkg))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, range]) => {
      const installed = facts.installed[name]
      return `${name}: ${range}${typeof installed === 'string' ? `, installed ${installed}` : ', not installed'}`
    })
  lines.push(`Lunette packages: ${packages.length > 0 ? '' : 'none'}`.trimEnd(), ...packages.map((p) => `  - ${p}`))

  const config = facts.config
  if ('none' in config) {
    // No file is the defaults, as for every command.
    lines.push(`configuration: ${config.none}`)
    return { lines }
  }
  if ('invalid' in config) {
    // A file that does not validate is an error.
    lines.push(`configuration: ${config.invalid}`)
    return { lines, configError: config.invalid }
  }
  // Where the project came from (the lunette key, written by @lntt/create): a report on a template
  // names it.
  const lunette = (config.data as { lunette?: { template: string; version: string } }).lunette
  lines.push(`template: ${lunette ? `${lunette.template}, @lntt/create ${lunette.version}` : 'none'}`)
  const at = config.path.startsWith(`${root}/`) ? config.path.slice(root.length + 1) : config.path
  lines.push(`configuration: ${at}`, '```json', JSON.stringify(config.data, null, 2), '```')
  return { lines }
}

// The dump of the facts gathered, redacted.
export function dumpOf(input: DumpFacts): Dump {
  const { root, env, harnessVersion } = input
  const lntt = input.lntt.version
  const dir = input.lntt.dir

  const detected = HARNESSES.find((h) => h.when(env))
  const harness = input.harness ?? (detected ? `${detected.name}${harnessVersion ? ` ${harnessVersion}` : ''}` : null)
  // ANTHROPIC_MODEL is Claude Code's: under another harness it names no model of its.
  const model = input.model ?? (detected?.name === 'Claude Code' ? env.ANTHROPIC_MODEL : undefined) ?? null

  const project = projectLines(root, input.project)
  const sections: DumpSection[] = [
    { title: 'lntt', lines: [`version: ${lntt}`, `installed: ${installKind(dir, root)}`, `path: ${dir}`] },
    {
      title: 'Runtime',
      lines: [
        `Node: ${input.node}`,
        `package manager: ${packageManager(input.project.pkg, input.project.locks)}`,
        `OS: ${input.os}`,
      ],
    },
    {
      title: 'Harness',
      lines: [`harness: ${harness ?? 'not detected (--harness)'}`, `model: ${model ?? 'not given (--model)'}`],
    },
    { title: 'Project', lines: project.lines },
  ]
  if (input.command) {
    const all = input.command.output.replace(/\n+$/, '').split('\n')
    const kept = all.slice(-OUTPUT_LINES)
    const fence = fenceFor(kept)
    sections.push({
      title: 'Command',
      lines: [
        `command: ${input.command.argv.join(' ')}`,
        `exit: ${input.command.status ?? input.command.stopped ?? 'killed by a signal'}`,
        ...(all.length > kept.length ? [`output (${all.length - kept.length} lines above left out):`] : ['output:']),
        fence,
        ...kept,
        fence,
      ],
    })
  }

  const redaction = redactionOf(input.home, input.remotes, env)
  const clean = (text: string) => redact(text, redaction)
  return {
    sections: sections.map((s) => ({ title: s.title, lines: s.lines.map(clean) })),
    harness: clean(harness ?? 'not detected'),
    model: clean(model ?? 'not given'),
    lntt,
    ...(project.configError === undefined ? {} : { configError: clean(project.configError) }),
  }
}

// A fence longer than any run of backticks in the lines it holds, so an output that
// holds a fence of its own stays inside it.
export function fenceFor(lines: string[]): string {
  const longest = Math.max(0, ...lines.flatMap((l) => (l.match(/`+/g) ?? []).map((run) => run.length)))
  return '`'.repeat(Math.max(3, longest + 1))
}

// Markdown: a heading per section, a bullet per fact, fenced blocks as they are: a block
// closes on the fence that opened it.
export function renderDump(dump: Dump): string {
  return dump.sections
    .map((section) => {
      let fence: string | null = null
      const body = section.lines.map((line) => {
        if (fence === null && /^`{3,}/.test(line)) {
          fence = /^`+/.exec(line)?.[0] as string
          return line
        }
        if (fence !== null) {
          if (line === fence) fence = null
          return line
        }
        if (line.startsWith('  ')) return line
        return `- ${line}`
      })
      return `### ${section.title}\n\n${body.join('\n')}\n`
    })
    .join('\n')
}

// Why a failing command stopped with no exit code, in a dump's words.
export const stoppedAfter = (timeoutMs: number): string =>
  `stopped after ${timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} s`}`

// The most output a failing command may print before it is stopped, in bytes.
export const OUTPUT_LIMIT = 64 * 1024 * 1024

export const OUTPUT_STOPPED = 'stopped: its output passed 64 MB'

// The harness and the model the agent gives, over those of a dump read from a file.
export function withAgent(dump: Dump, given: { harness?: string; model?: string }): Dump {
  if (given.harness === undefined && given.model === undefined) return dump
  const harness = given.harness ?? dump.harness
  const model = given.model ?? dump.model
  return {
    ...dump,
    harness,
    model,
    sections: dump.sections.map((s) =>
      s.title === 'Harness'
        ? {
            title: s.title,
            lines: s.lines.map((l) =>
              l.startsWith('harness: ') && given.harness !== undefined
                ? `harness: ${harness}`
                : l.startsWith('model: ') && given.model !== undefined
                  ? `model: ${model}`
                  : l,
            ),
          }
        : s,
    ),
  }
}
