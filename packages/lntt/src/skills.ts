// The shared skills (docs/adr/agent-layer.md). Their guides ship in this package, and
// `lntt guide <skill>` prints one, so a skill and the `lntt` it calls are always one
// version: the project's lockfile. A project holds only stubs, one per skill, in
// `.agents/skills/`, which Codex, OpenCode, Gemini CLI and Cursor read, and in
// `.claude/skills/`, which Claude Code reads: the skill's frontmatter, for discovery,
// and the instruction to load the guide. The project's own skills beside them are left
// alone.
//
// Plain logic, on texts: src/sync/project.ts reads and writes the folders.

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

// A checkout with core.autocrlf turns line endings into CRLF: the same text.
export const lf = (text: string): string => text.replaceAll('\r\n', '\n')

// What `lntt guide <skill>` prints: the folder its relative links start from, then the
// guide itself.
export function guideText(name: string, folder: string, skill: string): string {
  return `<!-- lntt guide ${name}: relative links start from ${folder} -->\n\n${skill}`
}

// The stub of a skill, from the text of its SKILL.md in the package; null when it has no
// frontmatter.
export function stub(name: string, skill: string): string | null {
  const frontmatter = /^---\n[\s\S]*?\n---\n/.exec(lf(skill))?.[0]
  if (frontmatter === undefined) return null
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

// A stub of lntt sync: the marker right after the frontmatter, not quoted further down
// by a skill of the project's own.
export function isStub(skill: string): boolean {
  return /^---\n[\s\S]*?\n---\n(.*)\n/.exec(lf(skill))?.[1] === MARKER
}

// What a folder of a skill directory holds: the names in it, and its SKILL.md (null when
// there is none). `null` for no folder at all.
export interface Folder {
  names: string[]
  skill: string | null
}

const isStubFolder = (folder: Folder | null) => folder?.skill != null && isStub(folder.skill)

// A folder of the project's own that has a shared skill's name, with or without a
// SKILL.md: lntt sync never overwrites it. An empty folder, or one holding hidden files
// only, is free.
export function clashes(folder: Folder | null): boolean {
  return (folder?.names.some((f) => !f.startsWith('.')) ?? false) && !isStubFolder(folder)
}

// The state of a shared skill's folder against the stub lntt sync writes.
export function skillState(folder: Folder | null, written: string): InstalledSkill['state'] {
  if (clashes(folder)) return 'clash'
  if (folder?.skill == null) return 'missing'
  // A hidden file (Finder's .DS_Store) is never committed: not an edit.
  const whole = folder.names.filter((f) => !f.startsWith('.')).length === 1
  return whole && lf(folder.skill) === written ? 'ok' : 'edited'
}

// The names of a skill directory's folders that are stubs, sorted.
export function stubNames(folders: Record<string, Folder | null>): string[] {
  return Object.keys(folders)
    .filter((name) => isStubFolder(folders[name] ?? null))
    .sort()
}

export const CLASH = (paths: string[]) =>
  `${paths.join(', ')}: a skill of the project's own with the name of a shared skill; rename it, then run pnpm exec lntt sync`
