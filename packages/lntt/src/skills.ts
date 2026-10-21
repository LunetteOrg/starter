// The shared skills (docs/adr/agent-layer.md). Their guides ship in this package, and
// `lntt guide <skill>` prints one, so a skill and the `lntt` it calls are always one
// version: the project's lockfile. A project holds only stubs, one per skill, in
// `.agents/skills/`, which Codex, OpenCode, Gemini CLI and Cursor read, and in
// `.claude/skills/`, which Claude Code reads: the skill's frontmatter, for discovery,
// and the instruction to load the guide. The project's own skills beside them are left
// alone.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigError } from './files.ts'
import { findConfig } from './index.ts'

// `skills/` in this repo; published, the build copies it to dist/skills, beside dist/src.
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '../skills')
// The line that tells a stub written by lntt sync from a skill of the project's own.
const MARKER = '<!-- installed by lntt sync from @lntt/lntt: edit the skill in the package, not this stub -->'

export const SKILL_DIRS = ['.agents/skills', '.claude/skills'] as const

export interface InstalledSkill {
  // Relative to the project root: `.claude/skills/decisions`.
  path: string
  // `unknown`: a stub naming a skill the package does not have; `clash`: a skill of the
  // project's own with a shared skill's name.
  state: 'ok' | 'missing' | 'edited' | 'unknown' | 'clash'
}

// A skill is a folder holding a SKILL.md.
export function sharedSkills(): string[] {
  return readdirSync(SOURCE, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(SOURCE, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort()
}

export function skillFolder(name: string): string | null {
  return sharedSkills().includes(name) ? join(SOURCE, name) : null
}

// What `lntt guide <skill>` prints: the folder its relative links start from, then the
// guide itself.
export function guide(name: string): string | null {
  const folder = skillFolder(name)
  if (folder === null) return null
  return `<!-- lntt guide ${name}: relative links start from ${folder} -->\n\n${readFileSync(join(folder, 'SKILL.md'), 'utf8')}`
}

export function stub(name: string): string {
  const text = read(join(SOURCE, name, 'SKILL.md'))
  const frontmatter = /^---\n[\s\S]*?\n---\n/.exec(text)?.[0]
  if (frontmatter === undefined) throw new Error(`skills/${name}/SKILL.md of @lntt/lntt has no frontmatter`)
  return [
    `${frontmatter}${MARKER}`,
    '',
    `The guide of this skill comes with the project's \`lntt\`, at its version. Before acting,`,
    'load it and follow it:',
    '',
    '```sh',
    `pnpm exec lntt guide ${name}`,
    '```',
    '',
  ].join('\n')
}

function projectRoot(cwd: string): string {
  return dirname(dirname(findConfig(cwd).path))
}

// A checkout with core.autocrlf turns line endings into CRLF: the same text.
function read(file: string): string {
  return readFileSync(file, 'utf8').replaceAll('\r\n', '\n')
}

// A stub of lntt sync: the marker right after the frontmatter, not quoted further down
// by a skill of the project's own.
function isStub(folder: string): boolean {
  const file = join(folder, 'SKILL.md')
  return existsSync(file) && /^---\n[\s\S]*?\n---\n(.*)\n/.exec(read(file))?.[1] === MARKER
}

// The stub folders of a directory, by name.
function stubsIn(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isStub(join(dir, e.name)))
    .map((e) => e.name)
    .sort()
}

// Every stub folder of the project, relative to its root: written by lntt sync and
// checked by the skills area, never by the project's other checks.
export function stubFolders(root: string): string[] {
  return SKILL_DIRS.flatMap((dir) => stubsIn(join(root, dir)).map((name) => `${dir}/${name}`))
}

// A folder of the project's own that has a shared skill's name, with or without a
// SKILL.md: lntt sync never overwrites it. An empty folder, or one holding hidden files
// only, is free.
function clashes(folder: string): boolean {
  return existsSync(folder) && readdirSync(folder).some((f) => !f.startsWith('.')) && !isStub(folder)
}

// Writes a stub for every shared skill, whole (a stub folder holds its SKILL.md only),
// and removes the stubs of skills the package no longer has. Writes nothing while a
// skill of the project's own has a shared skill's name.
export function syncSkills(cwd: string): void {
  const root = projectRoot(cwd)
  const names = sharedSkills()
  const clashing = SKILL_DIRS.flatMap((dir) => names.map((name) => `${dir}/${name}`)).filter((path) =>
    clashes(join(root, path)),
  )
  if (clashing.length > 0) {
    throw new ConfigError(
      `${clashing.join(', ')}: a skill of the project's own with the name of a shared skill; rename it, then run lntt sync`,
    )
  }
  for (const dir of SKILL_DIRS) {
    for (const name of stubsIn(join(root, dir)).filter((n) => !names.includes(n))) {
      rmSync(join(root, dir, name), { recursive: true, force: true })
    }
    for (const name of names) {
      const folder = join(root, dir, name)
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'SKILL.md'), stub(name))
      for (const extra of readdirSync(folder).filter((f) => f !== 'SKILL.md')) {
        rmSync(join(folder, extra), { recursive: true, force: true })
      }
    }
  }
}

// Each shared skill in each directory, in that order, then each stub naming a skill the
// package does not have.
export function checkSkills(cwd: string): InstalledSkill[] {
  const root = projectRoot(cwd)
  const names = sharedSkills()
  const installed = SKILL_DIRS.flatMap((dir) =>
    names.map((name): InstalledSkill => {
      const path = `${dir}/${name}`
      const folder = join(root, path)
      if (clashes(folder)) return { path, state: 'clash' }
      if (!existsSync(join(folder, 'SKILL.md'))) return { path, state: 'missing' }
      // A hidden file (Finder's .DS_Store) is never committed: not an edit.
      const whole = readdirSync(folder).filter((f) => !f.startsWith('.')).length === 1
      return { path, state: whole && read(join(folder, 'SKILL.md')) === stub(name) ? 'ok' : 'edited' }
    }),
  )
  const unknown = SKILL_DIRS.flatMap((dir) =>
    stubsIn(join(root, dir))
      .filter((name) => !names.includes(name))
      .map((name): InstalledSkill => ({ path: `${dir}/${name}`, state: 'unknown' })),
  )
  return [...installed, ...unknown]
}
