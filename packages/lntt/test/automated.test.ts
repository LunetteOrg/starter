import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  AUTOMATED_MARKER,
  automatedEntries,
  automatedLine,
  checkAutomated,
  matchAutomated,
  syncAutomated,
} from '../src/automated.ts'

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/lntt.ts')

const DEPENDABOT = { author: 'dependabot[bot]', branch: 'dependabot/', runs: 'after-approval', ci: 'full' } as const
const RENOVATE = { author: 'renovate[bot]', branch: 'renovate/', runs: 'always', ci: 'minimal' } as const

describe('matchAutomated', () => {
  const entries = [DEPENDABOT, RENOVATE]

  test('an entry matches its author and its branch prefix, both', () => {
    assert.equal(matchAutomated(entries, { author: 'dependabot[bot]', headRef: 'dependabot/npm/x' }), DEPENDABOT)
    assert.equal(matchAutomated(entries, { author: 'renovate[bot]', headRef: 'renovate/vite' }), RENOVATE)
    assert.equal(matchAutomated(entries, { author: 'octocat', headRef: 'dependabot/npm/x' }), null)
    assert.equal(matchAutomated(entries, { author: 'dependabot[bot]', headRef: 'feat/1/x' }), null)
    assert.equal(matchAutomated(entries, { author: 'renovate[bot]', headRef: 'dependabot/npm/x' }), null)
    assert.equal(matchAutomated(entries, { headRef: 'dependabot/npm/x' }), null)
  })

  test("gh's names for a bot match its event login: app/<slug> and the bare slug", () => {
    assert.equal(matchAutomated(entries, { author: 'app/dependabot', headRef: 'dependabot/npm/x' }), DEPENDABOT)
    assert.equal(matchAutomated(entries, { author: 'dependabot', headRef: 'dependabot/npm/x' }), DEPENDABOT)
    assert.equal(matchAutomated([], { author: 'dependabot[bot]', headRef: 'dependabot/npm/x' }), null)
  })

  test('the entries come from delivery.automated, none without it', () => {
    assert.deepEqual(automatedEntries({ delivery: { automated: [DEPENDABOT] } }), [DEPENDABOT])
    assert.deepEqual(automatedEntries({}), [])
  })
})

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

  test('is the minified entries, single-quoted, with the marker', () => {
    assert.equal(
      automatedLine('AUTOMATED', [DEPENDABOT]),
      `AUTOMATED: '[{"author":"dependabot[bot]","branch":"dependabot/","runs":"after-approval","ci":"full"}]' ${AUTOMATED_MARKER}`,
    )
    // YAML doubles a single quote inside single quotes.
    assert.match(automatedLine('A', [{ ...DEPENDABOT, branch: "it's/" }]), /"it''s\/"/)
  })

  test('lntt sync rewrites every marked line, keeping its key and indent, and leaves other workflows alone', () => {
    writeFileSync(join(root, '.agents/config.jsonc'), config([DEPENDABOT]))
    writeFileSync(join(root, '.github/workflows/ci.yml'), workflow(`AUTOMATED: '[]' ${AUTOMATED_MARKER}`))
    writeFileSync(join(root, '.github/workflows/other.yml'), 'name: Other\n')
    assert.equal(checkAutomated(root)[0]?.status, 'FAIL')
    const out = spawnSync(process.execPath, [BIN, 'sync'], { cwd: root, encoding: 'utf8' })
    assert.equal(out.status, 0, out.stderr)
    assert.equal(
      readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'),
      workflow(automatedLine('AUTOMATED', [DEPENDABOT])),
    )
    assert.equal(readFileSync(join(root, '.github/workflows/other.yml'), 'utf8'), 'name: Other\n')
    assert.deepEqual(syncAutomated(root), [])
    assert.deepEqual(
      checkAutomated(root).map((r) => [r.status, r.path]),
      [['PASS', '.github/workflows/ci.yml']],
    )
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

  test('with no marked line there is nothing to check', () => {
    writeFileSync(join(root, '.agents/config.jsonc'), config([DEPENDABOT]))
    writeFileSync(join(root, '.github/workflows/ci.yml'), 'name: CI\n')
    assert.deepEqual(
      checkAutomated(root).map((r) => r.status),
      ['NOT RUN'],
    )
  })
})
