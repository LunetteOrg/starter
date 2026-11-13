// The fixtures of test/fixtures as texts, for the specs that read a project in memory (lntt check's
// Tree, the in-memory FileSystem). Not published: tsconfig.build.json leaves src/testing/ out.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { memoryFileSystem } from './file-system.ts'

const FIXTURES = fileURLToPath(new URL('../../test/fixtures/', import.meta.url))

// Every file of test/fixtures/<name>, by its path from that folder.
export function fixture(name: string): Record<string, string> {
  const dir = join(FIXTURES, name)
  const out: Record<string, string> = {}
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const abs = join(entry.parentPath, entry.name)
    out[abs.slice(dir.length + 1)] = readFileSync(abs, 'utf8')
  }
  return out
}

// A file system in memory holding `texts` under `root`, their folders made.
export function filesAt(root: string, texts: Record<string, string>) {
  const paths = Object.keys(texts).map((path) => `${root}/${path}`)
  const fs = memoryFileSystem({ dirs: [root, ...paths.map((path) => path.slice(0, path.lastIndexOf('/')))] })
  for (const [path, text] of Object.entries(texts)) fs.files.set(`${root}/${path}`, { text, mtime: 0 })
  return fs
}
