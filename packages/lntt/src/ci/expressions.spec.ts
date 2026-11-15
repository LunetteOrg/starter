import { assert, describe, it } from '@effect/vitest'
import { type Context, evaluate, interpolate } from './expressions.ts'

const context: Context = {
  github: {
    event_name: 'pull_request',
    base_ref: 'main',
    event: { action: 'synchronize', pull_request: { draft: false, base: { ref: 'main' } } },
  },
  env: { A: '1' },
  secrets: { CANARY: 'fake' },
}

const ok = { failed: false }

describe('evaluate', () => {
  it('event and draft conditions', () => {
    assert.deepStrictEqual(evaluate("github.event_name == 'pull_request'", context, ok), { known: true, value: true })
    assert.deepStrictEqual(evaluate('!github.event.pull_request.draft', context, ok), { known: true, value: true })
    assert.deepStrictEqual(evaluate("github.event_name == 'push'", context, ok), { known: true, value: false })
  })

  it('status functions follow the job so far', () => {
    assert.deepStrictEqual(evaluate('success()', context, ok), { known: true, value: true })
    assert.deepStrictEqual(evaluate('success()', context, { failed: true }), { known: true, value: false })
    assert.deepStrictEqual(evaluate('failure()', context, { failed: true }), { known: true, value: true })
    assert.deepStrictEqual(evaluate('always()', context, { failed: true }), { known: true, value: true })
    assert.deepStrictEqual(evaluate('cancelled()', context, ok), { known: true, value: false })
  })

  it('a missing env variable is empty, as on GitHub', () => {
    assert.deepStrictEqual(evaluate("env.MISSING == ''", context, ok), { known: true, value: true })
  })

  it('a path the local run cannot know makes the result unknown, naming it', () => {
    assert.deepStrictEqual(evaluate("needs.build.result == 'success'", context, ok), {
      known: false,
      unknown: ['needs.build.result'],
    })
    assert.deepStrictEqual(evaluate("secrets.DEPLOY != ''", context, ok), { known: false, unknown: ['secrets.DEPLOY'] })
    assert.deepStrictEqual(evaluate('github.event.pull_request.labels', context, ok), {
      known: false,
      unknown: ['github.event.pull_request.labels'],
    })
  })

  it('a declared fake secret is known', () => {
    assert.deepStrictEqual(evaluate("secrets.CANARY != ''", context, ok), { known: true, value: true })
  })

  it('a short-circuited branch is not needed', () => {
    assert.deepStrictEqual(evaluate("github.event_name == 'push' && needs.x.result == 'y'", context, ok), {
      known: true,
      value: false,
    })
  })

  it('a function the local run does not implement is unknown', () => {
    assert.deepStrictEqual(evaluate("hashFiles('**/x') != ''", context, ok), { known: false, unknown: ['hashFiles()'] })
  })
})

describe('interpolate', () => {
  it('format() as the parser writes an expression inside a string', () => {
    assert.deepStrictEqual(interpolate("format('sh check.sh origin/{0}', github.base_ref)", context), {
      known: true,
      value: 'sh check.sh origin/main',
    })
  })
})
