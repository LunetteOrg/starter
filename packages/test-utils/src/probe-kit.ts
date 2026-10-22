import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { onTestFinished } from 'vitest'

/**
 * A throwaway project built from file contents, for the guards' specs: probes written
 * here are never seen by this repo's lint or `lntt check tests`. Call it inside a test:
 * the project is removed when that test finishes. Not built: tsconfig.build.json leaves `*-kit.ts` out.
 */
export function probeProject(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-guards-')))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}
