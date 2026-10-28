// `lntt check`: what can be checked without judgement, one area per review lens, so a
// reviewer reads the result instead of redoing it by eye. Every check says PASS, FAIL or
// NOT RUN with its reason; INFO is what a check prints without passing or failing (the
// diff inventory, the figures of a record).

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { checkAgentsBlock } from './agents.ts'
import { checkDecisions, decisionBoardRefs, decisionFigures } from './check-decisions.ts'
import { runTests } from './check-tests.ts'
import { checkClaudeSettings, INVALID, SETTINGS } from './claude-settings.ts'
import { checkBody, RETRO_START, retrospectiveBlock, retrospectiveRules } from './pull-request.ts'
import { checkSkills, stubFolders } from './skills.ts'

export type Status = 'PASS' | 'FAIL' | 'NOT RUN' | 'INFO'

export interface Result {
  area: string
  check: string
  status: Status
  path: string | null
  line: number | null
  message: string
}

export const AREAS = ['agents-md', 'skills', 'plugin', 'decisions', 'tests', 'body'] as const
export type Area = (typeof AREAS)[number]

export function isArea(name: string): name is Area {
  return (AREAS as readonly string[]).includes(name)
}

// A check that cannot run at all: the project is not a git repository, or git is missing.
export class CannotRunError extends Error {
  override name = 'CannotRunError'
}

export interface CheckOptions {
  root: string
  data: Record<string, unknown>
  // Limits a check to what the diff from this ref touches, where that makes sense.
  base?: string
  // `tests mutate`: what is on the line, and what it becomes.
  mutation?: { text: string; to: string }
  // `body`: the pull request body read, and where from; the area does not run without it.
  body?: { text: string; from: string }
}

// The files a check reads: tracked or new and not ignored, relative to the root, less
// those of a nested project (a folder with a configuration of its own, a template) and of
// the stubs of the shared skills (checked by the skills area), whose own check they are.
export function projectFiles(root: string): string[] {
  let listed: string
  try {
    listed = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    })
  } catch {
    throw new CannotRunError(`git cannot list the files of ${root}: lntt check reads a git repository`)
  }
  const files = listed.split('\0').filter(Boolean)
  const nested = [
    ...new Set(
      files
        .map((f) => /^(.+)\/\.agents\/config\.(?:jsonc|yml)$/.exec(f)?.[1])
        .filter((dir): dir is string => dir !== undefined),
    ),
  ]
  const skip = [...nested, ...stubFolders(root)]
  return [...new Set(files)]
    .filter((f) => !skip.some((dir) => f.startsWith(`${dir}/`)) && existsSync(join(root, f)))
    .sort()
}

function agentsMd(root: string): Result[] {
  const ok = checkAgentsBlock(root)
  return [
    {
      area: 'agents-md',
      check: 'block',
      status: ok ? 'PASS' : 'FAIL',
      path: 'AGENTS.md',
      line: null,
      message: ok
        ? 'the managed block matches its source'
        : 'the managed block is missing or edited; run lntt sync (edit agents/block.md of @lntt/lntt, not the block)',
    },
  ]
}

function skills(root: string): Result[] {
  const off = checkSkills(root).filter((s) => s.state !== 'ok')
  if (off.length === 0) {
    return [
      {
        area: 'skills',
        check: 'installed',
        status: 'PASS',
        path: null,
        line: null,
        message: 'every shared skill has its stub in .agents/skills/ and .claude/skills/',
      },
    ]
  }
  return off.map((s) => ({
    area: 'skills',
    check: 'installed',
    status: 'FAIL',
    path: s.path,
    line: null,
    message: {
      missing: 'not installed; run lntt sync',
      edited:
        'differs from the stub lntt sync writes; run lntt sync (an installed skill is never edited: change it in @lntt/lntt)',
      unknown: 'a stub of a skill @lntt/lntt does not have; run lntt sync',
      clash: "a skill of the project's own with the name of a shared skill; rename it, then run lntt sync",
    }[s.state as 'missing' | 'edited' | 'unknown' | 'clash'],
  }))
}

// The entries of .claude/settings.json that lntt sync writes: the Lunette plugin from the
// package's directory marketplace, and the hook that installs the dependencies.
function plugin(root: string): Result[] {
  const off = checkClaudeSettings(root).filter((e) => e.state !== 'ok')
  const result = (status: Status, message: string): Result => ({
    area: 'plugin',
    check: 'settings',
    status,
    path: SETTINGS,
    line: null,
    message,
  })
  if (off.length === 0) {
    return [result('PASS', 'the Lunette plugin loads from node_modules/@lntt/lntt, and the install hook is in place')]
  }
  return off.map((e) =>
    result(
      'FAIL',
      {
        missing: `${e.key} is missing; run lntt sync`,
        elsewhere: `${e.key} points elsewhere than the marketplace @lntt/lntt ships; run lntt sync`,
        off: `${e.key} is not enabled; run lntt sync`,
        edited: `${e.key}: the install hook differs from the one lntt sync writes; run lntt sync`,
        invalid: INVALID,
      }[e.state as 'missing' | 'elsewhere' | 'off' | 'edited' | 'invalid'],
    ),
  )
}

// The retrospective block (delivery.pullRequest.retrospective): `retrospective` in a pull
// request body, which is not in the repository and is given to the area (without one the
// check does not run); `template` in the pull request template, which must hold the block
// `lntt pr block` prints, so a label added to the configuration reaches the template.
function body(check: string | undefined, options: CheckOptions): Result[] {
  const results: Result[] = []
  if (check !== 'template') results.push(...bodyRetrospective(options))
  if (check === undefined || check === 'template') results.push(bodyTemplate(options))
  return results
}

function bodyRetrospective(options: CheckOptions): Result[] {
  const result = (status: Status, message: string): Result => ({
    area: 'body',
    check: 'retrospective',
    status,
    path: null,
    line: null,
    message,
  })
  if (options.body === undefined) {
    return [result('NOT RUN', 'no pull request body given: lntt check body [--pr <n> | -]')]
  }
  const problems = checkBody(options.body.text, retrospectiveRules(options.data))
  if (problems.length === 0) return [result('PASS', `${options.body.from}: every retrospective label is filled`)]
  return problems.map((p) => result('FAIL', `${options.body?.from}: ${p}`))
}

function bodyTemplate(options: CheckOptions): Result {
  const pullRequest = (options.data.delivery as { pullRequest?: { template?: string } } | undefined)?.pullRequest
  const path = pullRequest?.template ?? '.github/pull_request_template.md'
  const result = (status: Status, message: string): Result => ({
    area: 'body',
    check: 'template',
    status,
    path,
    line: null,
    message,
  })
  const file = join(options.root, path)
  if (!existsSync(file)) return result('NOT RUN', 'no pull request template')
  const text = readFileSync(file, 'utf8').replaceAll('\r\n', '\n')
  if (!text.split('\n').some((l) => l.trim() === RETRO_START)) {
    return result('FAIL', 'no retrospective block: paste what lntt pr block prints')
  }
  if (!text.includes(retrospectiveBlock(retrospectiveRules(options.data)).trimEnd())) {
    return result(
      'FAIL',
      'the retrospective block differs from the configuration: replace it with what lntt pr block prints',
    )
  }
  return result('PASS', 'the retrospective block is the one lntt pr block prints')
}

// One area, or one of its checks: `structure`, `board-refs` and `numbers` for the decisions, `levels`,
// `focus`, `rules`, `touched` and `mutate` for the tests.
export function runArea(area: Area, check: string | undefined, files: string[], options: CheckOptions): Result[] {
  if (area === 'agents-md') return agentsMd(options.root)
  if (area === 'skills') return skills(options.root)
  if (area === 'plugin') return plugin(options.root)
  if (area === 'tests') return runTests(check, files, options)
  if (area === 'body') return body(check, options)
  if (check === 'numbers') return decisionFigures(options, files)
  if (check === 'board-refs') return decisionBoardRefs(options, files)
  return checkDecisions(options, { figures: check === undefined })
}

export type Cited = { text: string | null } | { missing: string; what: 'file' | 'line' }

// An anchor's line, written as models write it: `:12`, a range `:12-15` or `:12–15`, a
// column `:12:5`, a list `:12,14`; each names its first line.
export const ANCHOR_LINE = /^(.+?):(\d+)(?:[-–,:]\d+)*$/

// What is on a line, so a finding is never built on a line that does not exist. The
// anchor may carry a heading (`#decision`) or a line in any form ANCHOR_LINE reads; a
// path alone only has to exist. The text is null for a path alone.
export function cite(root: string, anchor: string, line: number | null): Cited {
  const m = ANCHOR_LINE.exec(anchor)
  const path = (m ? (m[1] as string) : anchor).replace(/#.*$/, '')
  const at = line ?? (m ? Number(m[2]) : null)
  const rel = isAbsolute(path) ? relative(root, path) : path
  const abs = join(root, rel)
  if (rel.startsWith('..') || !existsSync(abs) || !statSync(abs).isFile())
    return { missing: 'no such file', what: 'file' }
  if (at === null) return { text: null }
  const lines = readFileSync(abs, 'utf8').replace(/\n$/, '').split('\n')
  if (at < 1 || at > lines.length)
    return {
      missing: `no line ${at}: the file has ${lines.length} line${lines.length === 1 ? '' : 's'}`,
      what: 'line',
    }
  return { text: (lines[at - 1] as string).trim() }
}

export function citeAll(root: string, anchors: string[]): Result[] {
  return anchors.map((anchor) => {
    const [, path, line] = ANCHOR_LINE.exec(anchor) as unknown as [string, string, string]
    const found = cite(root, path, Number(line))
    return {
      area: 'cite',
      check: 'line',
      status: 'missing' in found ? 'FAIL' : 'PASS',
      path,
      line: Number(line),
      message: 'missing' in found ? found.missing : (found.text ?? ''),
    }
  })
}

const ORDER: Status[] = ['FAIL', 'NOT RUN', 'INFO', 'PASS']

// One line per result, the ones that need someone first, then the counts.
export function formatText(results: Result[]): string {
  const sorted = [...results].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))
  const lines = sorted.map((r) => {
    const where = r.path === null ? '' : `  ${r.path}${r.line === null ? '' : `:${r.line}`}`
    return `${r.status.padEnd(9)}${r.area}/${r.check}${where} — ${r.message}`
  })
  const count = (s: Status) => results.filter((r) => r.status === s).length
  lines.push(`lntt check: ${count('PASS')} PASS, ${count('FAIL')} FAIL, ${count('NOT RUN')} NOT RUN`)
  return `${lines.join('\n')}\n`
}

export function formatJson(results: Result[]): string {
  return results.map((r) => `${JSON.stringify(r)}\n`).join('')
}

export function failed(results: Result[]): boolean {
  return results.some((r) => r.status === 'FAIL')
}
