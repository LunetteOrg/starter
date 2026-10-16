// Reads, validates and edits a Lunette project's configuration: `.agents/config.jsonc`
// or `.agents/config.yml`. Both formats carry comments, which is why scripts read the
// file through here instead of `jq` or `JSON.parse`, and why writes go through an
// editor that keeps them (jsonc-parser `modify`, the `yaml` Document API).

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Ajv } from 'ajv'
import jsonc from 'jsonc-parser'
import { isMap, parseDocument } from 'yaml'
import schema from '../schema/config.schema.json' with { type: 'json' }
import { ConfigError, check, type Located, locate, parse } from './files.ts'

export { checkAgentsBlock, managedBlock, syncAgentsBlock } from './agents.ts'
export {
  type BranchRules,
  branchName,
  branchRules,
  type Check,
  checkBranch,
  fromToolName,
  slugify,
  typeFor,
} from './branch.ts'
export { commitlintConfig } from './commitlint.ts'
export { ConfigError, type Format, type Located } from './files.ts'
export { type LocalApp, localApp } from './local.ts'
export { loadOperator, type Operator } from './operator.ts'
export { type Choice, chooseViewer, commandExists, detectHost, type Host, openWith, type Viewer } from './viewer.ts'
export {
  type Agent,
  agentArgs,
  type BriefValues,
  type Runner,
  renderBrief,
  type Start,
  type Started,
  setupScript,
  shellLaunch,
  startGit,
  startHerdr,
  startOrca,
  type WorktreeHost,
  worktreeHost,
} from './worktree.ts'

export interface Loaded extends Located {
  data: Record<string, unknown>
}

const validate = new Ajv({ allErrors: true, strict: true }).compile(schema)

// Walks up from `cwd` to the nearest directory holding `.agents/config.*`.
export function findConfig(cwd: string): Located {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const found = locate(join(dir, '.agents'), 'config')
    if (found) return found
    if (dirname(dir) === dir) {
      throw new ConfigError(`no .agents/config.jsonc or .agents/config.yml in ${cwd} or above`)
    }
  }
}

export function loadConfig(cwd: string): Loaded {
  const located = findConfig(cwd)
  const data = check(validate, parse(readFileSync(located.path, 'utf8'), located) ?? {}, located.path)
  return { ...located, data }
}

// A dotted key (`recording.logs.adr.path`). A missing key is an error: a script that
// reads `undefined` would go on with a wrong value.
export function getValue(data: unknown, key: string): unknown {
  let value: unknown = data
  const walked: string[] = []
  for (const part of key.split('.')) {
    walked.push(part)
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) {
      throw new ConfigError(`no ${walked.join('.')} in the configuration`)
    }
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

// Sets a dotted key, keeping every comment in the file. The new content is validated
// before it is written, so a rejected value leaves the file as it was.
export function setValue(cwd: string, key: string, value: unknown): void {
  const located = findConfig(cwd)
  const text = readFileSync(located.path, 'utf8')
  const keyPath = key.split('.')
  let next: string
  if (located.format === 'jsonc') {
    const edits = jsonc.modify(text, keyPath, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } })
    next = jsonc.applyEdits(text, edits)
  } else {
    const doc = parseDocument(text)
    if (!isMap(doc.contents) && doc.contents !== null) {
      throw new ConfigError(`${located.path}: the top level is not a map`)
    }
    doc.setIn(keyPath, value)
    next = doc.toString()
  }
  check(validate, parse(next, located), located.path)
  writeFileSync(located.path, next)
}
