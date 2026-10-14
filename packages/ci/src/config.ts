// The `ci.local` section of .agents/config.*, read through @lntt/project-config. A
// project without the file, or without the section, gets the defaults: nothing
// cloud-only, no fake values, the built-in actions only.

import { ConfigError, loadConfig } from '@lntt/project-config'

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

export function ciConfig(cwd: string): CiConfig {
  let data: Record<string, unknown>
  try {
    data = loadConfig(cwd).data
  } catch (error) {
    // No configuration at all is a project that has not adopted it yet; a broken one
    // is an error to fix.
    if (error instanceof ConfigError && error.message.startsWith('no .agents/config')) return emptyConfig()
    throw error
  }
  const local = (data.ci as Section | undefined)?.local ?? {}
  return {
    cloudOnly: local.cloudOnly ?? {},
    fake: { secrets: local.fake?.secrets ?? {}, vars: local.fake?.vars ?? {} },
    actions: local.actions ?? {},
  }
}
