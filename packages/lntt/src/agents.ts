// The part of AGENTS.md common to every Lunette project: one block between markers,
// written from `agents/block.md` and never edited by hand. Everything outside the
// markers is the project's. A block placed on top lets the project sections below
// refine it.
//
// Plain logic, on texts: `lntt sync` writes the block and `lntt check agents-md` reads it
// through src/sync/project.ts.

const START = '<!-- lunette:start'
const END = '<!-- lunette:end -->'
const BLOCK = new RegExp(`${START}[^\\n]*-->\\n[\\s\\S]*?${END}\\n?`)

// The block, from the text of `agents/block.md`.
export function managedBlock(source: string): string {
  return `${START} — managed by lntt sync: edit the source, not this block -->\n${source.trimEnd()}\n${END}\n`
}

// AGENTS.md with the block: in place of the one it holds, else on top; the block alone when
// there is no AGENTS.md (`text` null).
export function withManagedBlock(text: string | null, block: string): string {
  if (text === null) return block
  return BLOCK.test(text) ? text.replace(BLOCK, block) : `${block}\n${text}`
}

// Whether AGENTS.md (null when there is none) holds the block as it is written now.
export function holdsManagedBlock(text: string | null, block: string): boolean {
  return text?.match(BLOCK)?.[0] === block
}
