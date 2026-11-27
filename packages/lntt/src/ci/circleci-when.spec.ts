import { assert, describe, it } from '@effect/vitest'
import { evaluateWhen, substituteParameters } from './circleci-when.ts'

const pr = {
  'pipeline.event.name': 'pull_request',
  'pipeline.event.github.pull_request.base.ref': 'candidate/3',
  'pipeline.git.branch': 'feat/x',
}
const push = { 'pipeline.event.name': 'push', 'pipeline.git.branch': 'main' }

describe('evaluateWhen', () => {
  it('missing, booleans and their strings', () => {
    assert.deepStrictEqual(evaluateWhen(undefined, pr), { known: true, value: true })
    assert.deepStrictEqual(evaluateWhen(false, pr), { known: true, value: false })
    assert.deepStrictEqual(evaluateWhen('true', pr), { known: true, value: true })
  })

  it('expressions with == != and or not and parentheses, short-circuited', () => {
    const full = 'pipeline.event.name != "pull_request" or pipeline.event.github.pull_request.base.ref == "main"'
    assert.deepStrictEqual(evaluateWhen(full, pr), { known: true, value: false })
    // On a push the base ref does not exist, and is never read.
    assert.deepStrictEqual(evaluateWhen(full, push), { known: true, value: true })
    const minimal = 'pipeline.event.name == "pull_request" and pipeline.event.github.pull_request.base.ref != "main"'
    assert.deepStrictEqual(evaluateWhen(minimal, pr), { known: true, value: true })
    assert.deepStrictEqual(evaluateWhen(minimal, push), { known: true, value: false })
    assert.deepStrictEqual(evaluateWhen('not (pipeline.git.branch == "main")', push), { known: true, value: false })
  })

  it('logic maps', () => {
    assert.deepStrictEqual(evaluateWhen({ equal: ['main', 'main'] }, pr), { known: true, value: true })
    assert.deepStrictEqual(evaluateWhen({ and: [true, { not: false }] }, pr), { known: true, value: true })
    assert.deepStrictEqual(evaluateWhen({ or: [false, { equal: [1, 2] }] }, pr), { known: true, value: false })
    assert.deepStrictEqual(evaluateWhen({ matches: { pattern: '^feat/.*$', value: 'feat/x' } }, pr), {
      known: true,
      value: true,
    })
  })

  it('a value the local run does not have is unknown', () => {
    assert.deepStrictEqual(evaluateWhen('pipeline.trigger_source == "webapp"', pr), {
      known: false,
      unknown: ['pipeline.trigger_source'],
    })
  })
})

describe('substituteParameters', () => {
  it('<< pipeline.parameters.x >> in strings, kept typed when it is the whole value', () => {
    assert.deepStrictEqual(
      substituteParameters(
        { when: '<< pipeline.parameters.run >>', name: 'a-<< pipeline.parameters.n >>' },
        {
          run: true,
          n: 2,
        },
      ),
      { when: true, name: 'a-2' } as unknown,
    )
  })
})

describe('pipeline values inside logic maps', () => {
  it('<< pipeline.git.branch >> is the event branch', () => {
    assert.deepStrictEqual(evaluateWhen({ equal: ['main', '<< pipeline.git.branch >>'] }, push), {
      known: true,
      value: true,
    })
    assert.deepStrictEqual(evaluateWhen({ equal: ['main', '<< pipeline.git.branch >>'] }, pr), {
      known: true,
      value: false,
    })
    assert.deepStrictEqual(evaluateWhen({ matches: { pattern: '^feat/', value: '<< pipeline.git.branch >>' } }, pr), {
      known: true,
      value: true,
    })
  })

  it('a pipeline value the local run does not have is unknown, not a silent false', () => {
    assert.deepStrictEqual(evaluateWhen({ equal: ['webapp', '<< pipeline.trigger_source >>'] }, pr), {
      known: false,
      unknown: ['pipeline.trigger_source'],
    })
  })
})
