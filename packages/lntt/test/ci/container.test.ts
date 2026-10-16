import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { missingTools } from '../../src/ci/container.ts'
import type { Job } from '../../src/ci/plan.ts'

const job = (key: string, container: string[], state: Job['state'] = { state: 'run' }): Job => ({
  key,
  provider: key.startsWith('circleci') ? 'circleci' : 'github',
  workflow: 'w',
  needs: [],
  state,
  notes: [],
  steps: [],
  container,
})

describe('missingTools', () => {
  const jobs = [
    job('ci.yml/a', ['act', 'pull_request']),
    job('circleci/b', ['circleci', 'local', 'execute']),
    job('release.yml/r', ['act', 'release'], { state: 'cloud-only', reason: 'r' }),
  ]

  test('names the executors and Docker that are not on the PATH', () => {
    assert.deepEqual(
      missingTools(jobs, undefined, (c) => c === 'docker'),
      ['act', 'circleci'],
    )
    assert.deepEqual(
      missingTools(jobs, undefined, () => true),
      [],
    )
  })

  test('only for the jobs that would run', () => {
    assert.deepEqual(
      missingTools(jobs, ['circleci/b'], () => false),
      ['circleci', 'docker'],
    )
  })
})
