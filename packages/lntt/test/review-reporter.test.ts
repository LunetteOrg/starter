import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { reporter, startProgress } from '../src/review-cli.ts'

describe('the beat of lntt review', () => {
  const home = process.cwd()
  let repo: string

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'lntt-beat-')))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    process.chdir(repo)
    startProgress()
  })

  afterEach(() => {
    process.chdir(home)
    rmSync(repo, { recursive: true, force: true })
  })

  const beats = () =>
    readFileSync(join(repo, '.git/lntt-review.progress'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === 'beat')
      .map((event) => event.running)

  // The clock is the test's: a beat is 15 seconds of it.
  test('a beat every 15 seconds in the progress file; stderr hears every second one, and only while an agent runs', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const lines: string[] = []
    t.mock.method(process.stderr, 'write', (chunk: string) => {
      lines.push(String(chunk))
      return true
    })
    const report = reporter()
    const running = () => lines.filter((line) => line.includes('running'))

    t.mock.timers.tick(14_999)
    assert.deepEqual(beats(), [], 'no beat before 15 seconds')
    t.mock.timers.tick(1)
    t.mock.timers.tick(15_000)
    assert.deepEqual(beats(), [0, 0])
    assert.deepEqual(running(), [], 'nothing runs, nothing to say')

    report.progress({ type: 'start', index: 0, label: 'code · claude sonnet', optional: false })
    t.mock.timers.tick(15_000)
    assert.deepEqual(beats(), [0, 0, 1])
    assert.deepEqual(running(), [], 'the third beat is not heard on stderr')
    t.mock.timers.tick(15_000)
    assert.deepEqual(beats(), [0, 0, 1, 1])
    assert.equal(running().length, 1)
    assert.match(running()[0] as string, /^lntt review: running 1 \(\d+s\): code · claude sonnet\n$/)

    report.stop()
    t.mock.timers.tick(30_000)
    assert.equal(beats().length, 4, 'no beat after stop')
  })
})
