import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { E2E_PORT_RANGE, e2ePort, worktreeE2ePort } from './e2e-port.ts'

const ROOT_A = '/Users/someone/project'
const ROOT_B = '/Users/someone/project/.worktrees/other-branch'
const APPS = ['web', 'admin'] as const

describe('worktreeE2ePort', () => {
  it('is the same on every call for one checkout', () => {
    expect(worktreeE2ePort(ROOT_A, { app: 'web', apps: APPS })).toBe(
      worktreeE2ePort(ROOT_A, { app: 'web', apps: APPS }),
    )
  })

  it('ignores a trailing slash', () => {
    expect(worktreeE2ePort(`${ROOT_A}/`, { app: 'web', apps: APPS })).toBe(
      worktreeE2ePort(ROOT_A, { app: 'web', apps: APPS }),
    )
  })

  it('gives a symlink the port of its target', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-e2e-port-')))
    try {
      mkdirSync(join(dir, 'checkout'))
      symlinkSync(join(dir, 'checkout'), join(dir, 'link'), 'dir')
      expect(worktreeE2ePort(join(dir, 'link'), { app: 'web', apps: APPS })).toBe(
        worktreeE2ePort(join(dir, 'checkout'), { app: 'web', apps: APPS }),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('gives two checkouts different ports', () => {
    expect(worktreeE2ePort(ROOT_A, { app: 'web', apps: APPS })).not.toBe(
      worktreeE2ePort(ROOT_B, { app: 'web', apps: APPS }),
    )
  })

  it('gives each app of one checkout its own port, next to the others', () => {
    const ports = APPS.map((app) => worktreeE2ePort(ROOT_A, { app, apps: APPS }))
    expect(new Set(ports).size).toBe(APPS.length)
    expect(ports[1]).toBe((ports[0] as number) + 1)
  })

  it('stays in the range, below the ephemeral ports of Linux and macOS', () => {
    expect(E2E_PORT_RANGE.max).toBeLessThan(32_768)
    for (let i = 0; i < 500; i++) {
      for (const app of APPS) {
        const port = worktreeE2ePort(`/checkouts/wt-${i}`, { app, apps: APPS })
        expect(port).toBeGreaterThanOrEqual(E2E_PORT_RANGE.min)
        expect(port).toBeLessThanOrEqual(E2E_PORT_RANGE.max)
      }
    }
  })

  it('takes the app alone as the only app', () => {
    expect(worktreeE2ePort(ROOT_A, { app: 'web' })).toBe(worktreeE2ePort(ROOT_A, { app: 'web', apps: ['web'] }))
  })

  it('throws on an app missing from the list', () => {
    expect(() => worktreeE2ePort(ROOT_A, { app: 'shop', apps: APPS })).toThrow(/shop.*web, admin/)
  })
})

describe('e2ePort', () => {
  const derived = worktreeE2ePort(ROOT_A, { app: 'admin', apps: APPS })

  it('is derived from the checkout by default', () => {
    expect(e2ePort({ root: ROOT_A, app: 'admin', apps: APPS, env: {} })).toBe(derived)
  })

  it('takes E2E_PORT first', () => {
    expect(e2ePort({ root: ROOT_A, app: 'admin', apps: APPS, env: { E2E_PORT: '4567' } })).toBe(4567)
  })

  it('takes the CI port when CI is set', () => {
    expect(e2ePort({ root: ROOT_A, app: 'admin', apps: APPS, ciPort: 3200, env: { CI: 'true' } })).toBe(3200)
  })

  it('stays derived in CI when no CI port is given', () => {
    expect(e2ePort({ root: ROOT_A, app: 'admin', apps: APPS, env: { CI: 'true' } })).toBe(derived)
  })

  it('takes E2E_PORT over the CI port', () => {
    const env = { CI: 'true', E2E_PORT: '4000' }
    expect(e2ePort({ root: ROOT_A, app: 'admin', apps: APPS, ciPort: 3200, env })).toBe(4000)
  })

  it.each(['abc', '0', '-1', '65536', '3100.5', ' 4000 ', '0x10', '1e3'])('rejects E2E_PORT=%j', (value) => {
    expect(() => e2ePort({ root: ROOT_A, app: 'admin', apps: APPS, env: { E2E_PORT: value } })).toThrow(/E2E_PORT/)
  })
})
