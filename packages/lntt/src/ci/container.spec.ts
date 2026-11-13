import { assert, describe, it } from '@effect/vitest'
import { emptyConfig } from './config.ts'
import { containerArgs, eventPayload, neededTools } from './container.ts'
import type { Event } from './event.ts'
import type { Job } from './plan.ts'

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

describe('neededTools', () => {
  const jobs = [
    job('ci.yml/a', ['act', 'pull_request']),
    job('circleci/b', ['circleci', 'local', 'execute']),
    job('release.yml/r', ['act', 'release'], { state: 'cloud-only', reason: 'r' }),
  ]

  it('names the executors and Docker of the jobs that would run', () => {
    assert.deepStrictEqual(neededTools(jobs), ['act', 'docker', 'circleci'])
  })

  it('only for the jobs --job names', () => {
    assert.deepStrictEqual(neededTools(jobs, ['circleci/b']), ['circleci', 'docker'])
  })
})

const event: Event = {
  name: 'pull_request',
  base: 'main',
  head: 'feat/x',
  sha: 'abc',
  baseRef: 'origin/main',
  changed: [],
  repository: null,
  defaultBranch: 'main',
}

describe('containerArgs', () => {
  const config = { ...emptyConfig(), fake: { secrets: { TOKEN: 'fake' }, vars: { MODE: 'ci' } } }

  it('gives CircleCI its fake secrets as -e, and asks for no event file', () => {
    let asked = 0
    const args = containerArgs(config, () => {
      asked++
      return '/tmp/event.json'
    })
    assert.deepStrictEqual(args(job('circleci/b', ['circleci', 'local', 'execute'])), [
      'circleci',
      'local',
      'execute',
      '-e',
      'TOKEN=fake',
    ])
    assert.strictEqual(asked, 0)
  })

  it('gives act the event file, asked for once, the fake secrets as -s and the vars as --var', () => {
    let asked = 0
    const args = containerArgs(config, () => {
      asked++
      return '/tmp/event.json'
    })
    const expected = ['act', 'pull_request', '-e', '/tmp/event.json', '-s', 'TOKEN=fake', '--var', 'MODE=ci']
    assert.deepStrictEqual(args(job('ci.yml/a', ['act', 'pull_request'])), expected)
    assert.deepStrictEqual(args(job('ci.yml/a', ['act', 'pull_request'])), expected)
    assert.strictEqual(asked, 1)
    assert.strictEqual(args({ ...job('ci.yml/c', []), container: undefined } as Job), null)
  })
})

describe('eventPayload', () => {
  it('a ready pull request into the base, or a push to it', () => {
    assert.deepStrictEqual(JSON.parse(eventPayload(event)), {
      action: 'synchronize',
      pull_request: { draft: false, base: { ref: 'main' }, head: { ref: 'feat/x' } },
    })
    assert.deepStrictEqual(JSON.parse(eventPayload({ ...event, name: 'push' })), { ref: 'refs/heads/main' })
  })
})
