// The sections of .agents/config.* this package reads, through @lntt/project-config:
// `ci.local` (without it: nothing cloud-only, no fake values, the built-in actions
// only) and `delivery.candidate` (without it: no candidate).

import { ConfigError, loadConfig } from '@lntt/project-config'
import type { CandidateConfig } from './candidate.ts'

export type ActionMapping = { run: string } | { skip: string }

export interface CiConfig {
  cloudOnly: Record<string, string>
  fake: { secrets: Record<string, string>; vars: Record<string, string> }
  actions: Record<string, ActionMapping>
}

interface Section {
  local?: {
    cloudOnly?: Record<string, string>
    fake?: { secrets?: Record<string, string>; vars?: Record<string, string> }
    actions?: Record<string, ActionMapping>
  }
}

export function emptyConfig(): CiConfig {
  return { cloudOnly: {}, fake: { secrets: {}, vars: {} }, actions: {} }
}

// The configuration's data; none at all is a project that has not adopted it yet,
// while a broken one is an error to fix.
function data(cwd: string): Record<string, unknown> {
  try {
    return loadConfig(cwd).data
  } catch (error) {
    if (error instanceof ConfigError && error.message.startsWith('no .agents/config')) return {}
    throw error
  }
}

export function ciConfig(cwd: string): CiConfig {
  const config = data(cwd)
  const local = (config.ci as Section | undefined)?.local ?? {}
  return {
    cloudOnly: local.cloudOnly ?? {},
    fake: { secrets: local.fake?.secrets ?? {}, vars: local.fake?.vars ?? {} },
    actions: local.actions ?? {},
  }
}

// delivery.candidate with its defaults, or null when the project has no candidate.
export function candidateConfig(cwd: string): CandidateConfig | null {
  const section = (data(cwd).delivery as { candidate?: Partial<CandidateConfig> & { prefix: string } } | undefined)
    ?.candidate
  if (!section) return null
  return {
    base: section.base ?? 'main',
    prefix: section.prefix,
    hotfix: { prefix: section.hotfix?.prefix ?? 'hotfix/', label: section.hotfix?.label ?? 'hotfix' },
  }
}
