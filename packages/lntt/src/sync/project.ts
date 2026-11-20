// What `lntt sync` writes in a project and `lntt check` reads back, on Effect
// (docs/adr/effect-in-lntt.md): the managed block of AGENTS.md, the stubs of the shared skills,
// the entries of .claude/settings.json and the synced lines of the workflows. The files are read
// and written through FileSystem and Path; what to write is plain logic (src/agents.ts,
// src/skills.ts, src/claude-settings.ts, src/automated.ts). The sources come from lntt's own
// package (PackageDir), which a spec places in its in-memory file system.

import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import { holdsManagedBlock, managedBlock, withManagedBlock } from '../agents.ts'
import { automatedResults, syncedWorkflows, WORKFLOWS, type Workflow, workflowFiles } from '../automated.ts'
import { SETTINGS, settingsEntries, syncedSettings } from '../claude-settings.ts'
import {
  CLASH,
  clashes,
  type Folder,
  guideText,
  type InstalledSkill,
  SKILL_DIRS,
  skillState,
  stub,
  stubNames,
} from '../skills.ts'

// What lntt sync refuses (a skill of the project's own with a shared skill's name, a settings
// file that is not the shape Claude Code reads) or cannot build (a skill of the package with no
// frontmatter): reported by its message, exit 1.
export class SyncFailed extends Data.TaggedError('SyncFailed')<{ message: string }> {}

// lntt's package: agents/ and skills/ beside src/, in the repository and in dist/.
export const PackageDir = Context.Reference<string>('@lntt/lntt/sync/project/PackageDir', {
  defaultValue: () => decodeURIComponent(new URL('../..', import.meta.url).pathname).replace(/\/$/, ''),
})

// The text of a file, null when it is no file.
const readOrNull = Effect.fnUntraced(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const info = yield* fs.stat(file).pipe(Effect.option)
  if (info._tag === 'None' || info.value.type !== 'File') return null
  return yield* fs.readFileString(file)
})

const isDirectory = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.stat(file).pipe(
      Effect.map((info) => info.type === 'Directory'),
      Effect.orElseSucceed(() => false),
    ),
  )

// ---- the package --------------------------------------------------------------------

// The shared skills: the folders of the package's skills/ holding a SKILL.md, sorted.
export const sharedSkills = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = path.join(yield* PackageDir, 'skills')
  const names: string[] = []
  for (const name of yield* fs.readDirectory(dir)) {
    if ((yield* isDirectory(path.join(dir, name))) && (yield* fs.exists(path.join(dir, name, 'SKILL.md')))) {
      names.push(name)
    }
  }
  return names.sort()
})

// What `lntt guide <skill>` prints, null for a skill the package does not have.
export const guide = Effect.fnUntraced(function* (name: string) {
  if (!(yield* sharedSkills).includes(name)) return null
  const path = yield* Path.Path
  const folder = path.join(yield* PackageDir, 'skills', name)
  return guideText(name, folder, yield* (yield* FileSystem.FileSystem).readFileString(path.join(folder, 'SKILL.md')))
})

// The stub lntt sync writes for a shared skill.
const stubOf = Effect.fnUntraced(function* (name: string) {
  const path = yield* Path.Path
  const skill = yield* (yield* FileSystem.FileSystem).readFileString(
    path.join(yield* PackageDir, 'skills', name, 'SKILL.md'),
  )
  const written = stub(name, skill)
  if (written === null)
    return yield* new SyncFailed({ message: `skills/${name}/SKILL.md of @lntt/lntt has no frontmatter` })
  return written
})

// The block, from the package's agents/block.md.
const block = Effect.gen(function* () {
  const path = yield* Path.Path
  return managedBlock(
    yield* (yield* FileSystem.FileSystem).readFileString(path.join(yield* PackageDir, 'agents', 'block.md')),
  )
})

// ---- AGENTS.md ----------------------------------------------------------------------

// AGENTS.md sits next to `.agents/`, at the project root.
const agentsFile = (root: string) => Effect.map(Path.Path, (path) => path.join(root, 'AGENTS.md'))

// Whether AGENTS.md holds the block as the package writes it now.
export const agentsBlockHeld = Effect.fnUntraced(function* (root: string) {
  return holdsManagedBlock(yield* readOrNull(yield* agentsFile(root)), yield* block)
})

export const syncAgentsBlock = Effect.fnUntraced(function* (root: string) {
  const file = yield* agentsFile(root)
  yield* (yield* FileSystem.FileSystem).writeFileString(file, withManagedBlock(yield* readOrNull(file), yield* block))
})

// ---- the skills ---------------------------------------------------------------------

// A folder of a skill directory, null when there is none; a file in its place holds itself, so
// it clashes like a skill of the project's own.
const folderAt = Effect.fnUntraced(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const info = yield* fs.stat(folder).pipe(Effect.option)
  if (info._tag === 'None') return null
  if (info.value.type !== 'Directory') return { names: [path.basename(folder)], skill: null } satisfies Folder
  return { names: yield* fs.readDirectory(folder), skill: yield* readOrNull(path.join(folder, 'SKILL.md')) }
})

// The folders of a skill directory, by name; none when there is no directory.
const foldersIn = Effect.fnUntraced(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const folders: Record<string, Folder | null> = {}
  if (!(yield* isDirectory(dir))) return folders
  for (const name of yield* fs.readDirectory(dir)) {
    if (yield* isDirectory(path.join(dir, name))) folders[name] = yield* folderAt(path.join(dir, name))
  }
  return folders
})

// Each shared skill in each directory, in that order, then each stub naming a skill the
// package does not have.
export const installedSkills = Effect.fnUntraced(function* (root: string) {
  const path = yield* Path.Path
  const names = yield* sharedSkills
  const installed: InstalledSkill[] = []
  const unknown: InstalledSkill[] = []
  for (const dir of SKILL_DIRS) {
    const folders = yield* foldersIn(path.join(root, dir))
    for (const name of names) {
      installed.push({ path: `${dir}/${name}`, state: skillState(folders[name] ?? null, yield* stubOf(name)) })
    }
    for (const name of stubNames(folders).filter((n) => !names.includes(n))) {
      unknown.push({ path: `${dir}/${name}`, state: 'unknown' })
    }
  }
  return [...installed, ...unknown]
})

// Every stub folder of the project, relative to its root: written by lntt sync and checked by
// the skills area, never by the project's other checks.
export const stubFolders = Effect.fnUntraced(function* (root: string) {
  const path = yield* Path.Path
  const found: string[] = []
  for (const dir of SKILL_DIRS) {
    for (const name of stubNames(yield* foldersIn(path.join(root, dir)))) found.push(`${dir}/${name}`)
  }
  return found
})

// Writes a stub for every shared skill, whole (a stub folder holds its SKILL.md only), and
// removes the stubs of skills the package no longer has. Writes nothing while a skill of the
// project's own has a shared skill's name.
export const syncSkills = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const names = yield* sharedSkills
  const clashing: string[] = []
  for (const dir of SKILL_DIRS) {
    for (const name of names) {
      if (clashes(yield* folderAt(path.join(root, dir, name)))) clashing.push(`${dir}/${name}`)
    }
  }
  if (clashing.length > 0) return yield* new SyncFailed({ message: CLASH(clashing) })
  for (const dir of SKILL_DIRS) {
    const folders = yield* foldersIn(path.join(root, dir))
    for (const name of stubNames(folders).filter((n) => !names.includes(n))) {
      yield* fs.remove(path.join(root, dir, name), { recursive: true, force: true })
    }
    for (const name of names) {
      const folder = path.join(root, dir, name)
      yield* fs.makeDirectory(folder, { recursive: true })
      yield* fs.writeFileString(path.join(folder, 'SKILL.md'), yield* stubOf(name))
      for (const extra of (yield* fs.readDirectory(folder)).filter((f) => f !== 'SKILL.md')) {
        yield* fs.remove(path.join(folder, extra), { recursive: true, force: true })
      }
    }
  }
})

// ---- .claude/settings.json ----------------------------------------------------------

export const settingsOf = Effect.fnUntraced(function* (root: string) {
  const path = yield* Path.Path
  return settingsEntries(yield* readOrNull(path.join(root, SETTINGS)))
})

export const syncSettings = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(root, SETTINGS)
  const current = yield* readOrNull(file)
  const next = yield* Effect.try({
    try: () => syncedSettings(current),
    catch: (error) => new SyncFailed({ message: error instanceof Error ? error.message : String(error) }),
  })
  if (next === null) return
  yield* fs.makeDirectory(path.dirname(file), { recursive: true })
  yield* fs.writeFileString(file, next)
})

// ---- the workflows ------------------------------------------------------------------

// The workflow files of the project; none without the directory.
const workflowsOf = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const names = yield* fs.readDirectory(path.join(root, WORKFLOWS)).pipe(Effect.orElseSucceed(() => [] as string[]))
  const workflows: Workflow[] = []
  for (const file of workflowFiles(names)) {
    const text = yield* readOrNull(path.join(root, file))
    if (text !== null) workflows.push({ path: file, text })
  }
  return workflows
})

export const workflowResults = Effect.fnUntraced(function* (root: string, data: Record<string, unknown>) {
  return automatedResults(yield* workflowsOf(root), data)
})

// Rewrites the marked lines that differ; the files written.
export const syncWorkflows = Effect.fnUntraced(function* (root: string, data: Record<string, unknown>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const stale = syncedWorkflows(yield* workflowsOf(root), data)
  for (const { path: file, text } of stale) yield* fs.writeFileString(path.join(root, file), text)
  return stale.map((w) => w.path)
})

// ---- lntt sync ----------------------------------------------------------------------

// Everything lntt sync writes in the project at `root`, configured by `data`. The skills first:
// a clash with a project skill stops the command before any write.
export const syncProject = Effect.fnUntraced(function* (root: string, data: Record<string, unknown>) {
  yield* syncSkills(root)
  yield* syncAgentsBlock(root)
  yield* syncSettings(root)
  yield* syncWorkflows(root, data)
})
