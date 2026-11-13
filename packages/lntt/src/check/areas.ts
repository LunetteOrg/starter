// The areas of `lntt check` that read neither the decision logs nor the tests: the managed block
// of AGENTS.md, the installed skills, the plugin's settings, the synced workflow lines, and the
// retrospective block of a pull request's body and template.
//
// The first four read what `lntt sync` writes, with code not yet on Effect (src/agents.ts,
// src/skills.ts, src/claude-settings.ts, src/automated.ts, #341). lntt check reaches it at one
// place, SyncAreas, a Context.Reference whose default is that sync code, run under Effect.try: what
// it throws is a CheckFailed (docs/adr/effect-in-lntt.md#the-bridge-while-modules-move). A spec
// gives its own answers. What the results say is plain.

import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import { checkAgentsBlock } from '../agents.ts'
import { checkAutomated } from '../automated.ts'
import { checkClaudeSettings, HOOK_LABELS, INVALID, SETTINGS, type SettingsEntry } from '../claude-settings.ts'
import { checkBody, RETRO_START, retrospectiveBlock, retrospectiveRules } from '../pull-request.ts'
import { checkSkills, type InstalledSkill, stubFolders } from '../skills.ts'
import type { CheckOptions, Result, Status } from './results.ts'

// A check that cannot run at all (the project is not a git repository, git is missing, a pull
// request cannot be read), or sync code that threw: reported by its message, exit 1.
export class CheckFailed extends Data.TaggedError('CheckFailed')<{ message: string }> {}

export interface SyncChecks {
  // The managed block of AGENTS.md matches its source.
  readonly agentsBlock: (root: string) => boolean
  readonly skills: (root: string) => InstalledSkill[]
  // The stub folders of the shared skills, relative to the root.
  readonly stubFolders: (root: string) => string[]
  readonly settings: (root: string) => SettingsEntry[]
  readonly workflows: (root: string, data: Record<string, unknown>) => Result[]
}

export const SyncAreas = Context.Reference<SyncChecks>('@lntt/lntt/check/areas/SyncAreas', {
  defaultValue: () => ({
    agentsBlock: checkAgentsBlock,
    skills: checkSkills,
    stubFolders,
    settings: checkClaudeSettings,
    workflows: checkAutomated,
  }),
})

// One call of the sync code; what it throws is a CheckFailed.
export const synced = <A>(run: (checks: SyncChecks) => A) =>
  Effect.flatMap(SyncAreas, (checks) =>
    Effect.try({
      try: () => run(checks),
      catch: (cause) => new CheckFailed({ message: cause instanceof Error ? cause.message : String(cause) }),
    }),
  )

export function agentsMdResults(ok: boolean): Result[] {
  return [
    {
      area: 'agents-md',
      check: 'block',
      status: ok ? 'PASS' : 'FAIL',
      path: 'AGENTS.md',
      line: null,
      message: ok
        ? 'the managed block matches its source'
        : 'the managed block is missing or edited; run pnpm exec lntt sync (edit agents/block.md of @lntt/lntt, not the block)',
    },
  ]
}

export function skillsResults(installed: InstalledSkill[]): Result[] {
  const off = installed.filter((s) => s.state !== 'ok')
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
      missing: 'not installed; run pnpm exec lntt sync',
      edited:
        'differs from the stub lntt sync writes; run pnpm exec lntt sync (an installed skill is never edited: change it in @lntt/lntt)',
      unknown: 'a stub of a skill @lntt/lntt does not have; run pnpm exec lntt sync',
      clash: "a skill of the project's own with the name of a shared skill; rename it, then run pnpm exec lntt sync",
    }[s.state as 'missing' | 'edited' | 'unknown' | 'clash'],
  }))
}

// The entries of .claude/settings.json that lntt sync writes: the Lunette plugin from the
// package's directory marketplace, and the hook that installs the dependencies.
export function pluginResults(entries: SettingsEntry[]): Result[] {
  const off = entries.filter((e) => e.state !== 'ok')
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
        missing: `${e.key} is missing; run pnpm exec lntt sync`,
        elsewhere: `${e.key} points elsewhere than the marketplace @lntt/lntt ships; run pnpm exec lntt sync`,
        off: `${e.key} is not enabled; run pnpm exec lntt sync`,
        edited: `${e.key}: the ${HOOK_LABELS[e.key]} hook differs from the one lntt sync writes; run pnpm exec lntt sync`,
        invalid: INVALID,
      }[e.state as 'missing' | 'elsewhere' | 'off' | 'edited' | 'invalid'],
    ),
  )
}

// The retrospective block in a pull request body, which is not in the repository and is given to
// the area (without one the check does not run).
export function retrospectiveResults(options: Pick<CheckOptions, 'body' | 'data'>): Result[] {
  const result = (status: Status, message: string): Result => ({
    area: 'body',
    check: 'retrospective',
    status,
    path: null,
    line: null,
    message,
  })
  if (options.body === undefined) {
    return [result('NOT RUN', 'no pull request body given: pnpm exec lntt check body [--pr <n> | -]')]
  }
  const problems = checkBody(options.body.text, retrospectiveRules(options.data))
  if (problems.length === 0) return [result('PASS', `${options.body.from}: every retrospective label is filled`)]
  return problems.map((p) => result('FAIL', `${options.body?.from}: ${p}`))
}

// The pull request template the configuration names (delivery.pullRequest.template).
export function templatePath(data: Record<string, unknown>): string {
  const pullRequest = (data.delivery as { pullRequest?: { template?: string } } | undefined)?.pullRequest
  return pullRequest?.template ?? '.github/pull_request_template.md'
}

// The template must hold the block `lntt pr block` prints, so a label added to the configuration
// reaches it; `text` is null when there is no template.
export function templateResult(path: string, text: string | null, data: Record<string, unknown>): Result {
  const result = (status: Status, message: string): Result => ({
    area: 'body',
    check: 'template',
    status,
    path,
    line: null,
    message,
  })
  if (text === null) return result('NOT RUN', 'no pull request template')
  const lines = text.replaceAll('\r\n', '\n')
  if (!lines.split('\n').some((l) => l.trim() === RETRO_START)) {
    return result('FAIL', 'no retrospective block: paste what pnpm exec lntt pr block prints')
  }
  if (!lines.includes(retrospectiveBlock(retrospectiveRules(data)).trimEnd())) {
    return result(
      'FAIL',
      'the retrospective block differs from the configuration: replace it with what pnpm exec lntt pr block prints',
    )
  }
  return result('PASS', 'the retrospective block is the one lntt pr block prints')
}

// The text of a file of the project, null when it is no file.
export const readText = Effect.fnUntraced(function* (root: string, file: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const abs = path.join(root, file)
  const info = yield* fs.stat(abs).pipe(Effect.option)
  if (info._tag === 'None' || info.value.type !== 'File') return null
  return yield* fs.readFileString(abs)
})

// `body`: the retrospective block of the body given, and (alone or `template`) of the template.
export const bodyArea = Effect.fnUntraced(function* (check: string | undefined, options: CheckOptions) {
  const results: Result[] = []
  if (check !== 'template') results.push(...retrospectiveResults(options))
  if (check === undefined || check === 'template') {
    const path = templatePath(options.data)
    results.push(templateResult(path, yield* readText(options.root, path), options.data))
  }
  return results
})
