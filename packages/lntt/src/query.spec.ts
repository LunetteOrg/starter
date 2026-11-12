import { assert, describe, it } from '@effect/vitest'
import { runQuery } from './query.ts'

const doc = JSON.stringify({ area: 'agents-md', results: [{ id: 'a' }, { id: 'b' }] })
const query = (expression: string, over: Partial<Parameters<typeof runQuery>[0]> = {}) =>
  runQuery({ input: doc, expression, json: false, code: 0, command: 'lntt check', ...over })

describe('runQuery', () => {
  it('a string raw, each value compact on its line, and the command’s code kept', async () => {
    assert.deepStrictEqual(await query('.area', { code: 1 }), { code: 1, out: 'agents-md\n', err: '' })
    assert.deepStrictEqual(await query('.results[]'), { code: 0, out: '{"id":"a"}\n{"id":"b"}\n', err: '' })
    assert.deepStrictEqual(await query('.area', { json: true }), { code: 0, out: '"agents-md"\n', err: '' })
  })

  it('an expression that starts with a dash stays an expression', async () => {
    assert.deepStrictEqual(await query('-1'), { code: 0, out: '-1\n', err: '' })
  })

  it('a failing expression exits 2 with jq’s message and nothing on stdout', async () => {
    const failed = await query('.area | error("no")')
    assert.strictEqual(failed.code, 2)
    assert.strictEqual(failed.out, '')
    assert.match(failed.err, /no/)
    const syntax = await query('.[')
    assert.strictEqual(syntax.code, 2)
    assert.strictEqual(syntax.out, '')
  })

  it('a failure the command reads its own way: its code, its line before jq’s message', async () => {
    const own = await query('.state.open[]', {
      input: 'null',
      onFailure: (exit) => ({ code: 4, line: `none (${exit})` }),
    })
    assert.strictEqual(own.code, 4)
    assert.strictEqual(own.out, '')
    assert.match(own.err, /^none \(5\)\n/)
  })
})
