import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import lint from '@commitlint/lint'
import load from '@commitlint/load'
import { commitlintConfig } from '../src/index.ts'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-commitlint-')))
  mkdirSync(join(root, '.agents'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function configure(commits: unknown): void {
  writeFileSync(join(root, '.agents/config.jsonc'), JSON.stringify({ delivery: { commits } }))
}

async function check(message: string): Promise<string[]> {
  // `extends` resolves from the package, where @commitlint/config-conventional is installed.
  const config = await load(commitlintConfig(root), { cwd: import.meta.dirname })
  const result = await lint(message, config.rules, {
    plugins: config.plugins,
    parserOpts: config.parserPreset?.parserOpts as never,
  })
  return result.errors.map((e) => `${e.name}: ${e.message}`)
}

describe('the commitlint configuration built from delivery.commits', () => {
  test('a plain conventional commit passes', async () => {
    configure({})
    assert.deepEqual(await check('feat: add the run-local skill'), [])
  })

  test('a subject may start with a file name or an identifier, not with a capitalised word', async () => {
    configure({})
    assert.deepEqual(await check('feat: AGENTS.md gets a managed block'), [])
    assert.deepEqual(await check('fix: MAX_RETRIES counts from one'), [])
    const errors = await check('feat: Managed block for agents')
    assert.equal(errors.length, 1)
    assert.match(errors[0], /lower case/)
    assert.match(errors[0], /commit-message skill/)
  })

  test('the trailers named in longTrailers are exempt from the line limit', async () => {
    configure({ longTrailers: ['Retro'] })
    const retro = `Retro: ${'a long sentence about friction '.repeat(5)}`
    assert.deepEqual(await check(`feat: something\n\nBody.\n\n${retro}`), [])
    const errors = await check(`feat: something\n\nBody.\n\nRefs: ${'x'.repeat(120)}`)
    assert.ok(errors.some((e) => /100 characters/.test(e) && /commit-message skill/.test(e)))
  })

  test('maxLineLength comes from the configuration', async () => {
    configure({ maxLineLength: 72 })
    const errors = await check(`feat: something\n\n${'word '.repeat(16)}`)
    assert.ok(errors.some((e) => /72 characters/.test(e)))
  })

  test('scopes, when listed, are the only ones allowed', async () => {
    configure({ scopes: ['create', 'template'] })
    assert.deepEqual(await check('fix(template): drop a stale rule'), [])
    const errors = await check('fix(cli): drop a stale rule')
    assert.ok(errors.some((e) => /scope/.test(e) && /create, template/.test(e)))
  })

  test('an em dash in the subject and an attribution trailer are rejected with a reason', async () => {
    configure({})
    assert.ok((await check('feat: one thing — and another')).some((e) => /dash/.test(e)))
    const trailer = await check('feat: something\n\nBody.\n\nCo-Authored-By: someone <a@b.c>')
    assert.ok(trailer.some((e) => /attribution/.test(e)))
  })

  test('without a delivery section the defaults apply', async () => {
    writeFileSync(join(root, '.agents/config.jsonc'), '{}')
    assert.deepEqual(await check('docs: explain the block'), [])
  })
})
