// The sections of .agents/config.* that `lntt ci` reads, from the configuration's data:
// `ci.local` (without it: nothing cloud-only, no fake values, the built-in actions
// only, a machine-wide lock, 30 minutes per step) and `delivery.candidate` (without
// it: no candidate).

import { automatedEntries } from '../automated.ts'
import { readyRules } from '../board-ready.ts'
import { retrospectiveBlock, retrospectiveRules } from '../pull-request.ts'
import type { CandidateConfig } from './candidate.ts'
import type { LockScope } from './lock-rules.ts'

export type ActionMapping = { run: string } | { skip: string }

export interface CiConfig {
  cloudOnly: Record<string, string>
  fake: { secrets: Record<string, string>; vars: Record<string, string> }
  actions: Record<string, ActionMapping>
  // Who a run queues behind: every run on the machine, or the runs of this repository.
  lock: LockScope
  // How long one step (in container mode, one job) may run before it is stopped.
  timeoutMinutes: number
}

interface Section {
  local?: {
    cloudOnly?: Record<string, string>
    fake?: { secrets?: Record<string, string>; vars?: Record<string, string> }
    actions?: Record<string, ActionMapping>
    lock?: LockScope
    timeoutMinutes?: number
  }
}

export function emptyConfig(): CiConfig {
  return { cloudOnly: {}, fake: { secrets: {}, vars: {} }, actions: {}, lock: 'machine', timeoutMinutes: 30 }
}

// The ci.local section of the configuration's data, with its defaults.
export function ciConfigOf(config: Record<string, unknown>): CiConfig {
  const local = (config.ci as Section | undefined)?.local ?? {}
  return {
    cloudOnly: local.cloudOnly ?? {},
    fake: { secrets: local.fake?.secrets ?? {}, vars: local.fake?.vars ?? {} },
    actions: local.actions ?? {},
    lock: local.lock ?? 'machine',
    timeoutMinutes: local.timeoutMinutes ?? 30,
  }
}

// The board statuses a candidate sets when delivery.candidate.status leaves them out.
export const CANDIDATE_STATUS = Object.freeze({ inRelease: 'In release', done: 'Done' })

// delivery.candidate of the configuration's data with its defaults, or null when the project has no
// candidate.
export function candidateConfigOf(config: Record<string, unknown>): CandidateConfig | null {
  const section = (config.delivery as { candidate?: Partial<CandidateConfig> & { prefix: string } } | undefined)
    ?.candidate
  if (!section) return null
  const ready = readyRules(config)
  return {
    base: section.base ?? 'main',
    prefix: section.prefix,
    hotfix: { prefix: section.hotfix?.prefix ?? 'hotfix/', label: section.hotfix?.label ?? 'hotfix' },
    status: { ...CANDIDATE_STATUS, ...section.status },
    retrospective: retrospectiveBlock(retrospectiveRules(config)),
    automated: automatedEntries(config),
    ...(ready ? { ready } : {}),
  }
}
