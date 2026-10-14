import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { evaluateWhen, substituteParameters } from '../src/circleci-when.ts'

const pr = {
  'pipeline.event.name': 'pull_request',
  'pipeline.event.github.pull_request.base.ref': 'candidate/3',
  'pipeline.git.branch': 'feat/x',
}
const push = { 'pipeline.event.name': 'push', 'pipeline.git.branch': 'main' }

describe('evaluateWhen', () => {
  test('missing, booleans and their strings', () => {
    assert.deepEqual(evaluateWhen(undefined, pr), { known: true, value: true })
    assert.deepEqual(evaluateWhen(false, pr), { known: true, value: false })
    assert.deepEqual(evaluateWhen('true', pr), { known: true, value: true })
  })

  test('expressions with == != and or not and parentheses, short-circuited', () => {
    const full = 'pipeline.event.name != "pull_request" or pipeline.event.github.pull_request.base.ref == "main"'
    assert.deepEqual(evaluateWhen(full, pr), { known: true, value: false })
    // On a push the base ref does not exist, and is never read.
    assert.deepEqual(evaluateWhen(full, push), { known: true, value: true })
    const minimal = 'pipeline.event.name == "pull_request" and pipeline.event.github.pull_request.base.ref != "main"'
    assert.deepEqual(evaluateWhen(minimal, pr), { known: true, value: true })
    assert.deepEqual(evaluateWhen(minimal, push), { known: true, value: false })
    assert.deepEqual(evaluateWhen('not (pipeline.git.branch == "main")', push), { known: true, value: false })
  })

  test('logic maps', () => {
    assert.deepEqual(evaluateWhen({ equal: ['main', 'main'] }, pr), { known: true, value: true })
    assert.deepEqual(evaluateWhen({ and: [true, { not: false }] }, pr), { known: true, value: true })
    assert.deepEqual(evaluateWhen({ or: [false, { equal: [1, 2] }] }, pr), { known: true, value: false })
    assert.deepEqual(evaluateWhen({ matches: { pattern: '^feat/.*$', value: 'feat/x' } }, pr), {
      known: true,
      value: true,
    })
  })

  test('a value the local run does not have is unknown', () => {
    assert.deepEqual(evaluateWhen('pipeline.trigger_source == "webapp"', pr), {
      known: false,
      unknown: ['pipeline.trigger_source'],
    })
  })
})

describe('substituteParameters', () => {
  test('<< pipeline.parameters.x >> in strings, kept typed when it is the whole value', () => {
    assert.deepEqual(
      substituteParameters(
        { when: '<< pipeline.parameters.run >>', name: 'a-<< pipeline.parameters.n >>' },
        {
          run: true,
          n: 2,
        },
      ),
      { when: true, name: 'a-2' },
    )
  })
})

describe('pipeline values inside logic maps', () => {
  test('<< pipeline.git.branch >> is the event branch', () => {
    assert.deepEqual(evaluateWhen({ equal: ['main', '<< pipeline.git.branch >>'] }, push), { known: true, value: true })
    assert.deepEqual(evaluateWhen({ equal: ['main', '<< pipeline.git.branch >>'] }, pr), { known: true, value: false })
    assert.deepEqual(evaluateWhen({ matches: { pattern: '^feat/', value: '<< pipeline.git.branch >>' } }, pr), {
      known: true,
      value: true,
    })
  })

  test('a pipeline value the local run does not have is unknown, not a silent false', () => {
    assert.deepEqual(evaluateWhen({ equal: ['webapp', '<< pipeline.trigger_source >>'] }, pr), {
      known: false,
      unknown: ['pipeline.trigger_source'],
    })
  })
})
