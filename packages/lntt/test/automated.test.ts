import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { AUTOMATED_MARKER, automatedLine } from '../src/automated.ts'

// The main paths of the synced workflow lines through the CLI; the lines, their matching and
// their check: src/automated.spec.ts, src/sync/project.spec.ts.

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/lntt.ts')

const DEPENDABOT = { author: 'dependabot[bot]', branch: 'dependabot/', runs: 'after-approval', ci: 'full' } as const
const RENOVATE = { author: 'renovate[bot]', branch: 'renovate/', runs: 'always', ci: 'minimal' } as const

describe('the synced line', () => {
  let root: string
  const workflow = (line: string) =>
    `name: CI\njobs:\n  ci:\n    steps:\n      - env:\n          ${line}\n        run: echo "$AUTOMATED"\n`
  const config = (entries: unknown[]) => JSON.stringify({ delivery: { automated: entries } })

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-automated-')))
    mkdirSync(join(root, '.agents'))
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('lntt sync rewrites every marked line, keeping its key and indent, and leaves other workflows alone', () => {
    writeFileSync(join(root, '.agents/config.jsonc'), config([DEPENDABOT]))
    writeFileSync(join(root, '.github/workflows/ci.yml'), workflow(`AUTOMATED: '[]' ${AUTOMATED_MARKER}`))
    writeFileSync(join(root, '.github/workflows/other.yml'), 'name: Other\n')
    const out = spawnSync(process.execPath, [BIN, 'sync'], { cwd: root, encoding: 'utf8' })
    assert.equal(out.status, 0, out.stderr)
    assert.equal(
      readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'),
      workflow(automatedLine('AUTOMATED', [DEPENDABOT])),
    )
    assert.equal(readFileSync(join(root, '.github/workflows/other.yml'), 'utf8'), 'name: Other\n')
    const check = spawnSync(process.execPath, [BIN, 'check', 'workflows'], { cwd: root, encoding: 'utf8' })
    assert.equal(check.status, 0, check.stdout)
  })

  test('lntt check fails on a line that drifted from the configuration, naming the fix', () => {
    writeFileSync(join(root, '.agents/config.jsonc'), config([DEPENDABOT, RENOVATE]))
    writeFileSync(join(root, '.github/workflows/ci.yml'), workflow(automatedLine('AUTOMATED', [DEPENDABOT])))
    const out = spawnSync(process.execPath, [BIN, 'check', 'workflows'], { cwd: root, encoding: 'utf8' })
    assert.equal(out.status, 1, out.stdout)
    assert.match(
      out.stdout,
      /FAIL +workflows\/automated +\.github\/workflows\/ci\.yml:6 .*delivery\.automated.*lntt sync/,
    )
  })
})
