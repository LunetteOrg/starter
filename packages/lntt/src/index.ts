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
import { ConfigError, check, type Located, locate, NoConfigError, parse } from './files.ts'

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
export { ConfigError, type Format, type Located, NoConfigError } from './files.ts'
export {
  type Answer,
  type AskOptions,
  askAll,
  type HeadlessAgent,
  headlessInvocation,
  type Invocation,
  parseReply,
  providerOf,
  type Question,
  type Reply,
  type Spawn,
  timerMs,
} from './headless.ts'
export { type LocalApp, localApp } from './local.ts'
export { loadOperator, type Operator } from './operator.ts'
export {
  type Ask,
  agentLabel,
  type Checked,
  type Finding,
  type Found,
  isNoFindings,
  type Lens,
  lensApplies,
  mergeFindings,
  parseFindings,
  parseOutcome,
  parseWithdrawal,
  type Range,
  type ReviewConfig,
  type ReviewState,
  type RoundResult,
  renderReplyPrompt,
  renderReviewPrompt,
  renderVerifyPrompt,
  reviewConfig,
  roundClean,
  roundLimit,
  roundRange,
  runRound,
  type Severity,
  TEST_PATHS,
  unreadableFindings,
  verdict,
  verifiersFor,
} from './review.ts'
export {
  checkSkills,
  guide,
  type InstalledSkill,
  SKILL_DIRS,
  sharedSkills,
  skillFolder,
  stub,
  stubFolders,
  syncSkills,
} from './skills.ts'
export { type Choice, chooseViewer, commandExists, detectHost, type Host, openWith, type Viewer } from './viewer.ts'
export {
  type Agent,
  agentArgs,
  type BriefValues,
  type Runner,
  renderBrief,
  type SetupFor,
  type Start,
  type Started,
  setupScript,
  shellLaunch,
  startGit,
  startHerdr,
  startOrca,
  toolFailure,
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
      throw new NoConfigError(`no .agents/config.jsonc or .agents/config.yml in ${cwd} or above`)
    }
  }
}

export function loadConfig(cwd: string): Loaded {
  const located = findConfig(cwd)
  const data = checkStatuses(
    check(validate, parse(readFileSync(located.path, 'utf8'), located) ?? {}, located.path),
    located.path,
  )
  return { ...located, data }
}

const STATUS_ROLES = ['initial', 'ready', 'inProgress', 'inReview', 'done']

// What the schema cannot say: every status the skills set (a role of the Status field,
// a status of delivery.candidate) is one of the Status field's options, so a typo is
// caught here and not when the automation fails to move an item.
function checkStatuses(data: Record<string, unknown>, path: string): Record<string, unknown> {
  const field = (data.board as { fields?: { status?: Record<string, unknown> } } | undefined)?.fields?.status
  const options = field?.options as string[] | undefined
  if (!field || !options) return data
  const candidate = (data.delivery as { candidate?: { status?: Record<string, unknown> } } | undefined)?.candidate
  const named: [string, unknown][] = [
    ...STATUS_ROLES.map((role): [string, unknown] => [`board.fields.status.${role}`, field[role]]),
    ...Object.entries(candidate?.status ?? {}).map(([k, v]): [string, unknown] => [
      `delivery.candidate.status.${k}`,
      v,
    ]),
  ]
  const lines = named
    .filter(([, value]) => value !== undefined && !options.includes(value as string))
    .map(([key, value]) => `  ${key} is ${JSON.stringify(value)}, not one of the options: ${options.join(', ')}`)
  if (lines.length === 0) return data
  throw new ConfigError(`${path}: a status is not an option of board.fields.status:\n${lines.join('\n')}`)
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
  checkStatuses(check(validate, parse(next, located), located.path), located.path)
  writeFileSync(located.path, next)
}
