// `lntt dump`: the environment a report on Lunette itself needs (lntt issue), collected by
// a command instead of by hand, and redacted before anyone sends it: the lntt version and
// how it is installed, Node, the package manager and the OS, the harness and the model,
// the project's configuration, skills, hooks and Lunette packages, and the failing command
// with its output when there is one. The operator reads the whole dump before it leaves
// the machine (lntt issue sends nothing without --send).

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { arch, homedir, release, type } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'
import { loadConfig, NoConfigError } from './index.ts'

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

export interface DumpInput {
  root: string
  env: Record<string, string | undefined>
  // Given by the agent, which knows them better than the environment does.
  harness?: string
  model?: string
  command?: FailedCommand
  // `<command> --version`, the first line; null when it does not run.
  version?: (command: string) => string | null
  home?: string
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

// Where this lntt runs from, seen from the project's root.
export function installKind(packageDir: string, root: string): string {
  if (packageDir.includes('/_npx/')) return 'npx'
  if (packageDir.includes('/node_modules/')) {
    return packageDir.startsWith(`${root}/`) ? 'a dependency of the project' : 'outside the project (global)'
  }
  return 'from source (a workspace package)'
}

// The directory of @lntt/lntt: src/ in this repo, dist/src/ once packed.
export function packageDir(): string {
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    const file = join(dir, 'package.json')
    if (existsSync(file) && readJson(file)?.name === '@lntt/lntt') return dir
    if (dirname(dir) === dir) throw new Error('lntt: the package.json of @lntt/lntt is not above its code')
  }
}

export function packageJson(): { version?: string; repository?: string | { url?: string } } {
  return readJson(join(packageDir(), 'package.json')) ?? {}
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function defaultVersion(command: string): string | null {
  const run = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000 })
  if (run.status !== 0) return null
  const first = run.stdout.trim().split('\n')[0] ?? ''
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
export function redactionFor(root: string, env: Record<string, string | undefined>, home?: string): Redaction {
  return { home: home ?? env.HOME ?? homedir(), remotes: gitRemotes(root), secrets: environmentSecrets(env) }
}

function gitRemotes(root: string): string[] {
  const run = spawnSync('git', ['remote', '-v'], { cwd: root, encoding: 'utf8' })
  if (run.status !== 0) return []
  return [...new Set(run.stdout.split('\n').map((l) => l.split(/\s+/)[1] ?? ''))].filter((r) => r !== '')
}

function packageManager(root: string, pkg: Record<string, unknown> | null): string {
  if (typeof pkg?.packageManager === 'string') return pkg.packageManager.replace(/\+sha\d+\..*$/, '')
  const locks: [string, string][] = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['package-lock.json', 'npm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
  ]
  return locks.find(([file]) => existsSync(join(root, file)))?.[1] ?? 'unknown'
}

function dirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

function projectLines(root: string): { lines: string[]; configError?: string } {
  const lines: string[] = []
  const pkg = readJson(join(root, 'package.json'))

  const skills = ['.agents/skills', '.claude/skills']
    .map((dir) => [dir, dirs(join(root, dir))] as const)
    .filter(([, names]) => names.length > 0)
    .map(([dir, names]) => `${dir}: ${names.join(', ')}`)
  lines.push(`skills: ${skills.length > 0 ? skills.join('; ') : 'none'}`)

  const lefthook = ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml'].map((f) => join(root, f)).find(existsSync)
  if (lefthook) {
    const data = parseDocument(readFileSync(lefthook, 'utf8')).toJS() as Record<string, unknown> | null
    const hooks = Object.entries(data ?? {})
      .filter(([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v))
      .map(([k]) => k)
      .sort()
    lines.push(`git hooks (lefthook): ${hooks.join(', ') || 'none'}`)
  }
  const claude = readJson(join(root, '.claude/settings.json'))
  if (claude) {
    lines.push(`agent hooks (.claude/settings.json): ${Object.keys(claude.hooks ?? {}).join(', ') || 'none'}`)
    const plugins = Object.entries((claude.enabledPlugins ?? {}) as Record<string, boolean>)
      .filter(([, on]) => on)
      .map(([name]) => name)
    lines.push(`plugins: ${plugins.join(', ') || 'none'}`)
  }

  const declared: Record<string, string> = {}
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, range] of Object.entries((pkg?.[field] ?? {}) as Record<string, string>)) {
      if (name.startsWith('@lntt/')) declared[name] = range
    }
  }
  const packages = Object.entries(declared)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, range]) => {
      const installed = readJson(join(root, 'node_modules', name, 'package.json'))?.version
      return `${name}: ${range}${typeof installed === 'string' ? `, installed ${installed}` : ', not installed'}`
    })
  lines.push(`Lunette packages: ${packages.length > 0 ? '' : 'none'}`.trimEnd(), ...packages.map((p) => `  - ${p}`))

  try {
    const config = loadConfig(root)
    lines.push(`configuration: ${relative(root, config.path)}`, '```json', JSON.stringify(config.data, null, 2), '```')
  } catch (error) {
    const message = (error as Error).message
    lines.push(`configuration: ${message}`)
    // No file is the defaults, as for every command; a file that does not validate is an error.
    return error instanceof NoConfigError ? { lines } : { lines, configError: message }
  }
  return { lines }
}

export function collectDump(input: DumpInput): Dump {
  const { root, env } = input
  const version = input.version ?? defaultVersion
  const pkg = packageJson()
  const lntt = pkg.version ?? 'unknown'
  const dir = packageDir()

  const detected = HARNESSES.find((h) => h.when(env))
  const harnessVersion = detected ? version(detected.command) : null
  const harness = input.harness ?? (detected ? `${detected.name}${harnessVersion ? ` ${harnessVersion}` : ''}` : null)
  // ANTHROPIC_MODEL is Claude Code's: under another harness it names no model of its.
  const model = input.model ?? (detected?.name === 'Claude Code' ? env.ANTHROPIC_MODEL : undefined) ?? null

  const project = projectLines(root)
  const sections: DumpSection[] = [
    { title: 'lntt', lines: [`version: ${lntt}`, `installed: ${installKind(dir, root)}`, `path: ${dir}`] },
    {
      title: 'Runtime',
      lines: [
        `Node: ${process.version}`,
        `package manager: ${packageManager(root, readJson(join(root, 'package.json')))}`,
        `OS: ${type()} ${release()} ${arch()}`,
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

  const redaction = redactionFor(root, env, input.home)
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

// Runs the failing command as its words are given (sh only merges its stderr into its
// stdout, in the order they were written).
// It is stopped after `timeoutMs` (default 10 minutes), so a command that hangs does not
// hang the dump.
export function runFailing(argv: string[], cwd: string, timeoutMs = 10 * 60 * 1000): FailedCommand {
  // exec: the command takes the shell's place, so the timeout stops the command itself; a
  // process it started may outlive it.
  const run = spawnSync('sh', ['-c', 'exec "$@" 2>&1', 'sh', ...argv], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  })
  const code = (run.error as NodeJS.ErrnoException | undefined)?.code
  const stopped =
    code === 'ETIMEDOUT'
      ? `stopped after ${timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} s`}`
      : code === 'ENOBUFS'
        ? 'stopped: its output passed 64 MB'
        : run.signal
          ? `killed by ${run.signal}`
          : undefined
  return { argv, status: run.status, output: run.stdout ?? '', ...(stopped ? { stopped } : {}) }
}

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
