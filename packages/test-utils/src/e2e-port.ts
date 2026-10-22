// The port an app's e2e suite serves on, stable per checkout: two worktrees of one
// project run their suites at once without meeting on a port. It depends on Node only,
// so a playwright.config.ts can import it without loading the rest of the package.
// The reasons are in the starter's docs/adr/e2e-helpers.md.

import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Where derived ports land: below 32768, where Linux's ephemeral range starts (macOS's
 * starts at 49152), so a port the system hands out to a container mapping or a server
 * listening on port 0 never lands on a derived one.
 */
export const E2E_PORT_RANGE = { min: 20_000, max: 29_999 } as const

export interface WorktreeE2ePortOptions {
  /** The app whose port this is. */
  app: string
  /**
   * Every app of the project that runs an e2e suite, always in the same order: each
   * gets the port next to the previous one, inside the checkout's slot. Default: the
   * app alone.
   */
  apps?: readonly string[]
}

/**
 * The port derived from a hash of the checkout's real path. Two checkouts share a slot
 * with a chance of `apps.length` in 10,000 per pair: `E2E_PORT` on one
 * of them is the way out.
 */
export function worktreeE2ePort(root: string, { app, apps = [app] }: WorktreeE2ePortOptions): number {
  const index = appIndex(app, apps)
  const slots = Math.floor((E2E_PORT_RANGE.max - E2E_PORT_RANGE.min + 1) / apps.length)
  if (slots < 1) {
    throw new Error(
      `e2e port: ${apps.length} apps do not fit in ${E2E_PORT_RANGE.min} to ${E2E_PORT_RANGE.max}, one port each`,
    )
  }
  const slot = createHash('sha256').update(realPath(root)).digest().readUInt32BE(0) % slots
  return E2E_PORT_RANGE.min + slot * apps.length + index
}

function appIndex(app: string, apps: readonly string[]): number {
  if (new Set(apps).size !== apps.length) throw new Error(`e2e port: apps lists an app twice: ${apps.join(', ')}`)
  const index = apps.indexOf(app)
  if (index === -1) throw new Error(`e2e port: no app "${app}" among ${apps.join(', ')}`)
  return index
}

/** A path that does not exist yet still gets a port, from its lexical form. */
function realPath(root: string): string {
  try {
    return realpathSync(root)
  } catch {
    return resolve(root)
  }
}

export interface E2ePortOptions extends WorktreeE2ePortOptions {
  /** The checkout's root: the directory holding `pnpm-workspace.yaml`. */
  root: string
  /**
   * This app's port when `CI` is set (any non-empty value, as `@lntt/playwright-config`
   * reads it), where one job runs one suite. Default: the derived one.
   */
  ciPort?: number
  env?: Record<string, string | undefined>
}

/**
 * `E2E_PORT` first, as the port of the first app of `apps` and the ports after it for
 * the others; then `ciPort` when `CI` is set; then the port derived from the checkout.
 */
export function e2ePort({ root, ciPort, env = process.env, ...app }: E2ePortOptions): number {
  const forced = env.E2E_PORT
  if (forced) {
    const apps = app.apps ?? [app.app]
    const port = Number(forced)
    if (!/^\d+$/.test(forced) || port < 1 || port > 65_535) {
      throw new Error(`E2E_PORT must be an integer between 1 and 65535, got "${forced}"`)
    }
    if (port + apps.length - 1 > 65_535) {
      throw new Error(`E2E_PORT=${forced} leaves no port up to 65535 for each of the ${apps.length} apps`)
    }
    return port + appIndex(app.app, apps)
  }
  if (env.CI && ciPort !== undefined) {
    if (!Number.isInteger(ciPort) || ciPort < 1 || ciPort > 65_535) {
      throw new Error(`ciPort must be an integer between 1 and 65535, got ${ciPort}`)
    }
    return ciPort
  }
  return worktreeE2ePort(root, app)
}
