import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { type Context, evaluate, interpolate } from '../../src/ci/expressions.ts'

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
  test('event and draft conditions', () => {
    assert.deepEqual(evaluate("github.event_name == 'pull_request'", context, ok), { known: true, value: true })
    assert.deepEqual(evaluate('!github.event.pull_request.draft', context, ok), { known: true, value: true })
    assert.deepEqual(evaluate("github.event_name == 'push'", context, ok), { known: true, value: false })
  })

  test('status functions follow the job so far', () => {
    assert.deepEqual(evaluate('success()', context, ok), { known: true, value: true })
    assert.deepEqual(evaluate('success()', context, { failed: true }), { known: true, value: false })
    assert.deepEqual(evaluate('failure()', context, { failed: true }), { known: true, value: true })
    assert.deepEqual(evaluate('always()', context, { failed: true }), { known: true, value: true })
    assert.deepEqual(evaluate('cancelled()', context, ok), { known: true, value: false })
  })

  test('a missing env variable is empty, as on GitHub', () => {
    assert.deepEqual(evaluate("env.MISSING == ''", context, ok), { known: true, value: true })
  })

  test('a path the local run cannot know makes the result unknown, naming it', () => {
    assert.deepEqual(evaluate("needs.build.result == 'success'", context, ok), {
      known: false,
      unknown: ['needs.build.result'],
    })
    assert.deepEqual(evaluate("secrets.DEPLOY != ''", context, ok), { known: false, unknown: ['secrets.DEPLOY'] })
    assert.deepEqual(evaluate('github.event.pull_request.labels', context, ok), {
      known: false,
      unknown: ['github.event.pull_request.labels'],
    })
  })

  test('a declared fake secret is known', () => {
    assert.deepEqual(evaluate("secrets.CANARY != ''", context, ok), { known: true, value: true })
  })

  test('a short-circuited branch is not needed', () => {
    assert.deepEqual(evaluate("github.event_name == 'push' && needs.x.result == 'y'", context, ok), {
      known: true,
      value: false,
    })
  })

  test('a function the local run does not implement is unknown', () => {
    assert.deepEqual(evaluate("hashFiles('**/x') != ''", context, ok), { known: false, unknown: ['hashFiles()'] })
  })
})

describe('interpolate', () => {
  test('format() as the parser writes an expression inside a string', () => {
    assert.deepEqual(interpolate("format('sh check.sh origin/{0}', github.base_ref)", context), {
      known: true,
      value: 'sh check.sh origin/main',
    })
  })
})
