import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/index.ts'
import { testsConfig, testsFor } from '../src/test-files.ts'

// The selection `lntt check tests mutate` makes, on this repository's own files and levels.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean)
const config = testsConfig(loadConfig(ROOT).data)

const ran = (file: string) => testsFor(ROOT, config, files, file).flatMap((g) => g.files)

describe('the tests a mutation of a file of this repository runs', () => {
  test('a prompt a module reads is run by the tests of that module, and by none that cannot reach it', () => {
    const tests = ran('packages/lntt/agents/review/before-production.md')
    assert.ok(tests.includes('packages/lntt/test/review.test.ts'), tests.join(', '))
    for (const unrelated of ['branch', 'board', 'worktree', 'retro', 'exit', 'stdin']) {
      assert.ok(!tests.includes(`packages/lntt/test/${unrelated}.test.ts`), `${unrelated}.test.ts does not reach it`)
    }
    assert.ok(tests.length <= 8, `the whole level is not run: ${tests.length} files (${tests.join(', ')})`)
  })

  test('a source file keeps every test whose imports reach it, a spawned entry point included', () => {
    const tests = ran('packages/lntt/src/exit.ts')
    assert.ok(tests.includes('packages/lntt/test/exit.test.ts'))
    assert.ok(
      tests.includes('packages/lntt/test/stdin.test.ts'),
      'stdin.test.ts spawns bin/lntt.ts, which imports exit.ts',
    )
  })
})
