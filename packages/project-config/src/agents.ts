// The part of AGENTS.md common to every Lunette project: one block between markers,
// written from `agents/block.md` and never edited by hand. Everything outside the
// markers is the project's. A block placed on top lets the project sections below
// refine it.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findConfig } from './index.ts'

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '../agents/block.md')
const START = '<!-- lunette:start'
const END = '<!-- lunette:end -->'
const BLOCK = new RegExp(`${START}[^\\n]*-->\\n[\\s\\S]*?${END}\\n?`)

export function managedBlock(): string {
  const body = readFileSync(SOURCE, 'utf8').trimEnd()
  return `${START} — managed by lntt-config agents sync: edit the source, not this block -->\n${body}\n${END}\n`
}

// AGENTS.md sits next to `.agents/`, at the project root.
function agentsFile(cwd: string): string {
  return join(dirname(dirname(findConfig(cwd).path)), 'AGENTS.md')
}

export function syncAgentsBlock(cwd: string): void {
  const file = agentsFile(cwd)
  const block = managedBlock()
  if (!existsSync(file)) {
    writeFileSync(file, block)
    return
  }
  const text = readFileSync(file, 'utf8')
  writeFileSync(file, BLOCK.test(text) ? text.replace(BLOCK, block) : `${block}\n${text}`)
}

export function checkAgentsBlock(cwd: string): boolean {
  const file = agentsFile(cwd)
  if (!existsSync(file)) return false
  return readFileSync(file, 'utf8').match(BLOCK)?.[0] === managedBlock()
}
