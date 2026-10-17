// Coordinator mode: a theme's parent worktree delegates each issue to a child worktree
// and writes no code. This module holds what lntt decides for it: the model of each role,
// the gate on starting a child, and the two briefs. Starting the worktrees is
// worktree.ts; the questions between the agents are messages.ts.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fill } from './template.ts'
import type { Agent } from './worktree.ts'

export const SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const
export type Size = (typeof SIZES)[number]
export type Gate = 'propose' | 'free'

interface StartAgent {
  kind?: string
  model?: string
  effort?: string
}

interface CoordinatorSection {
  gate?: Gate
  models?: { coordinator?: StartAgent; children?: Partial<Record<Size, StartAgent>> }
}

export type Config = { coordinator?: CoordinatorSection }

const AGENTS = join(dirname(fileURLToPath(import.meta.url)), '../agents')
const template = (name: string) => readFileSync(join(AGENTS, name), 'utf8')

export function gateOf(config: Config): Gate {
  return config.coordinator?.gate ?? 'propose'
}

// The agent a role runs on: the configuration's entry for the role (a child's by Size),
// each field overridden by what the command line gave.
export function agentFor(
  config: Config,
  who: { role: 'coordinator' } | { role: 'child'; size?: string },
  given: Partial<Agent>,
): Agent {
  const models = config.coordinator?.models
  let configured: StartAgent | undefined
  if (who.role === 'coordinator') configured = models?.coordinator
  else if (who.size !== undefined) {
    if (!(SIZES as readonly string[]).includes(who.size)) {
      throw new Error(`--size is ${SIZES.slice(0, -1).join(', ')} or ${SIZES.at(-1)}, not ${who.size}`)
    }
    configured = models?.children?.[who.size as Size]
  }
  const merged = { ...configured, ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) }
  const { kind = 'claude', model, effort } = merged as StartAgent
  return { kind, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
}

// A proposal is approved by an answer that is one of these words: "yes, but not #84"
// approves nothing.
export function isApproval(answer: string): boolean {
  return /^\s*(approve|approved|yes|ok)[\s.!]*$/i.test(answer)
}

// The children a person approved for a theme, kept next to the mailbox they were
// approved through. No lntt command lets a coordinator add to it; one that writes the
// file itself is outside what the gate can stop (docs/adr/coordinator-mode.md).
const approvedFile = (root: string, theme: string) => join(root, `approved-${theme}.txt`)

export function approvals(root: string, theme: string): Set<number> {
  const file = approvedFile(root, theme)
  if (!existsSync(file)) return new Set()
  return new Set(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => /^[1-9]\d*$/.test(line))
      .map(Number),
  )
}

export function approve(root: string, theme: string, issues: number[]): void {
  mkdirSync(root, { recursive: true })
  const all = new Set([...approvals(root, theme), ...issues])
  // Whole or not at all: a concurrent reader never sees half a list.
  const file = approvedFile(root, theme)
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${[...all].join('\n')}\n`)
  renameSync(temporary, file)
}

function describeAgent(agent: StartAgent): string {
  const what = [agent.kind && agent.kind !== 'claude' ? agent.kind : null, agent.model ?? 'default']
    .filter(Boolean)
    .join(' ')
  return agent.effort ? `${what} (effort ${agent.effort})` : what
}

function modelsText(config: Config): string {
  const models = config.coordinator?.models
  if (!models?.coordinator && !models?.children) {
    return 'none is configured (`coordinator.models`): every role runs on its agent’s default. Reviews run on `delivery.review`.'
  }
  const children = SIZES.flatMap((size) => {
    const agent = models?.children?.[size]
    return agent ? [`${size} ${describeAgent(agent)}`] : []
  })
  return [
    `you run on ${describeAgent(models?.coordinator ?? {})}; \`--size\` picks a child’s by the issue’s Size (${children.join(', ') || 'none configured'}).`,
    'Anything that changes a public interface, infrastructure or a shared contract is sized M or larger, whatever its issue says.',
    'Reviews run on `delivery.review`, unchanged.',
  ].join(' ')
}

function gateText(config: Config, issues: { issue: number }[], approved: number[]): string {
  if (gateOf(config) === 'free') return 'start the children as soon as their order allows.'
  const first = issues.map((i) => i.issue).filter((n) => !approved.includes(n))
  return [
    '`lntt worktree start --parent` asks the orchestrator to approve a child before it creates anything, and waits for the answer.',
    approved.length > 0
      ? `Approved to start now: ${approved.map((n) => `#${n}`).join(', ')}.`
      : 'No child is approved yet.',
    first.length > 0 ? `To propose first: ${first.map((n) => `#${n}`).join(', ')}.` : 'Nothing is left to propose.',
  ].join(' ')
}

const orcaCard = (orca: string) =>
  `On Orca, keep the theme’s state on your card: \`${orca} worktree set --worktree current --comment "<state>"\`, and \`--unread\` when you wait for a person. Follow a child with \`${orca} terminal wait --for tui-idle --timeout-ms <n>\` and then \`terminal read\`, never a resend on silence; its card comment is the reliable state.`

export interface CoordinatorValues {
  theme: string
  worktree: string
  branch: string
  issues: { issue: number; title: string }[]
  approved: number[]
  config: Config
  // The orca binary by absolute path; null where the host is not Orca.
  orca: string | null
}

export function coordinatorBrief(v: CoordinatorValues): string {
  return fill(template('coordinator.md'), {
    theme: v.theme,
    worktree: v.worktree,
    branch: v.branch,
    issues: v.issues.map((i) => `  - #${i.issue}: ${i.title}`).join('\n'),
    models: modelsText(v.config),
    gate: gateText(v.config, v.issues, v.approved),
    card: v.orca ? orcaCard(v.orca) : '',
  })
}

export interface ChildValues {
  issue: number
  title: string
  branch: string
  worktree: string
}

// The brief of one issue. With a theme, the child belongs to a coordinator: the context
// the coordinator wrote, how to ask and report, and, on request, the workflow section.
export function childBrief(
  v: ChildValues,
  options: { theme?: string; context?: string; workflow?: boolean; orca?: string | null },
  brief = template('brief.md'),
): string {
  const card = options.orca
    ? `Keep your card current at each phase: \`${options.orca} worktree set --worktree current --comment "<state>"\`; the coordinator reads it.`
    : ''
  return fill(brief, {
    ...v,
    theme: options.context?.trim() ? `## The theme\n\n${options.context.trim()}` : '',
    reporting: options.theme
      ? fill(template('reporting.md'), { theme: options.theme, issue: v.issue, card }).trimEnd()
      : '',
    workflow: options.workflow ? template('workflow.md').trimEnd() : '',
  })
}
