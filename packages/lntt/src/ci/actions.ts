// What a local run does in place of a GitHub Actions `uses:` step. The actions below
// are known; ci.local.actions maps more, or overrides these. Any other action fails
// the run, so a new action in a workflow forces a decision: map it to a local
// command, skip it with a reason, or declare its job cloud-only.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CiConfig } from './config.ts'
import type { Local } from './plan.ts'

// As GitHub runs them on Linux: a step without `shell:` gets `bash -e {0}`, without
// pipefail; an explicit `shell: bash` adds it.
export const SHELLS: Record<string, string[]> = {
  default: ['bash', '-e', '-c'],
  bash: ['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c'],
  sh: ['sh', '-e', '-c'],
}

// `owner/repo[/path]` without the `@ref`.
export function actionName(uses: string): string {
  return uses.replace(/@.*$/, '')
}

// Whether `version` satisfies a setup-node spec written as a plain version prefix
// (`24`, `24.15`, `v24.15.0`). Anything else (`lts/*`, ranges) cannot be compared:
// null.
export function versionMatches(spec: string, version: string): boolean | null {
  const wanted = spec.trim().replace(/^v/, '')
  if (!/^\d+(\.\d+){0,2}$/.test(wanted)) return null
  const have = version.replace(/^v/, '').split('.')
  return wanted.split('.').every((part, i) => part === have[i])
}

function setupNode(root: string, inputs: Record<string, string>): Local {
  const file = inputs['node-version-file']
  let spec = inputs['node-version']
  let source = 'node-version'
  if (!spec && file) {
    const path = join(root, file)
    if (!existsSync(path)) return { kind: 'fail', reason: `node-version-file ${file} does not exist` }
    spec = readFileSync(path, 'utf8').trim()
    source = file
  }
  if (!spec) return { kind: 'noop', note: 'no Node version asked for: the host Node is used' }
  const asked = spec
  return {
    kind: 'check',
    note: `the host Node matches ${source} (${asked})`,
    check: () => {
      const match = versionMatches(asked, process.version)
      if (match === null) return null
      return match ? null : `host Node is ${process.version}, ${source} asks for ${asked}`
    },
  }
}

function onPath(command: string): boolean {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function localAction(uses: string, inputs: Record<string, string>, root: string, config: CiConfig): Local {
  const name = actionName(uses)
  const mapped = config.actions[name]
  if (mapped && 'run' in mapped) return { kind: 'run', command: mapped.run, shell: SHELLS.default, cwd: root, env: {} }
  if (mapped) return { kind: 'noop', note: mapped.skip }
  switch (name) {
    case 'actions/checkout':
      return { kind: 'noop', note: 'the working tree is the checkout' }
    case 'actions/cache':
    case 'actions/cache/restore':
    case 'actions/cache/save':
      return { kind: 'noop', note: 'no cloud cache on a local run' }
    case 'pnpm/action-setup':
      return {
        kind: 'check',
        note: 'pnpm is on the PATH',
        check: () => (onPath('pnpm') ? null : 'pnpm is not on the PATH'),
      }
    case 'actions/setup-node':
      return setupNode(root, inputs)
    default:
      return {
        kind: 'fail',
        reason: `${uses} has no local equivalent: map it in ci.local.actions (run or skip), or declare its job in ci.local.cloudOnly`,
      }
  }
}
