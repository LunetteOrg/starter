// lntt's own package in memory, for the specs of what `lntt sync` writes and `lntt check` reads
// (src/sync/project.ts): the source of AGENTS.md's managed block and three shared skills, under
// PACKAGE, which a spec gives as PackageDir. Not published: tsconfig.build.json leaves src/testing/
// out.

import { managedBlock } from '../agents.ts'
import { syncedSettings } from '../claude-settings.ts'
import { stub } from '../skills.ts'

export const PACKAGE = '/lntt'

export const BLOCK_SOURCE = '# Working in a Lunette project\n\n- Give criteria before options.\n'

const skill = (name: string) =>
  `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\n# ${name}\n\nSee [the rules](./references/rules.md).\n`

export const SKILLS = ['commit-message', 'decisions', 'review'] as const

// The package's files, by absolute path: a folder of skills/ with no SKILL.md and a file beside
// the skills are no skills.
export const PACKAGE_FILES: Record<string, string> = {
  [`${PACKAGE}/agents/block.md`]: BLOCK_SOURCE,
  ...Object.fromEntries(SKILLS.map((name) => [`${PACKAGE}/skills/${name}/SKILL.md`, skill(name)])),
  [`${PACKAGE}/skills/decisions/references/rules.md`]: '# Rules\n',
  [`${PACKAGE}/skills/drafts/notes.md`]: 'not a skill\n',
  [`${PACKAGE}/skills/README.md`]: 'not a skill either\n',
}

// The stub lntt sync writes for a skill of the package.
export const stubOf = (name: (typeof SKILLS)[number]) => stub(name, skill(name)) as string

// A project's files, by their path from its root, as lntt sync leaves them.
export const SYNCED: Record<string, string> = {
  'AGENTS.md': managedBlock(BLOCK_SOURCE),
  ...Object.fromEntries(
    ['.agents/skills', '.claude/skills'].flatMap((dir) =>
      SKILLS.map((name) => [`${dir}/${name}/SKILL.md`, stubOf(name)]),
    ),
  ),
  '.claude/settings.json': syncedSettings(null) as string,
}
