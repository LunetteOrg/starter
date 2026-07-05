import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertNoEntitySpreadInReturn, findReturnSpreads } from './serialization'

const FIXTURES = resolve(__dirname, '__fixtures__/serialization')

describe('findReturnSpreads', () => {
  it('flags a top-level spread in a returned object literal', () => {
    const hits = findReturnSpreads('function loader() { return { ...user, greeting: "hi" } }')
    expect(hits).toHaveLength(1)
  })

  it('flags a nested-object spread inside data(...)', () => {
    const hits = findReturnSpreads('function action() { return data({ user: { ...user } }) }')
    expect(hits).toHaveLength(1)
  })

  it('does NOT flag an array spread', () => {
    expect(findReturnSpreads('function loader() { return { tags: [...tags] } }')).toEqual([])
  })

  it('does NOT flag a call spread', () => {
    expect(findReturnSpreads('function loader() { return build(...args) }')).toEqual([])
  })

  it('does NOT flag an object spread outside a return (e.g. a header merge)', () => {
    const src = 'function loader() { const headers = { ...base }; return { id: user.id, headers } }'
    expect(findReturnSpreads(src)).toEqual([])
  })

  it('ignores a spread that appears inside a string literal', () => {
    expect(findReturnSpreads('function loader() { return { note: "use { ...x } here" } }')).toEqual(
      [],
    )
  })

  it('reports the line of the offending return', () => {
    const src = ['function loader() {', '  return { ...user }', '}'].join('\n')
    expect(findReturnSpreads(src)[0]?.line).toBe(2)
  })
})

describe('assertNoEntitySpreadInReturn', () => {
  it('passes on a route that returns explicit read-view literals', async () => {
    await expect(
      assertNoEntitySpreadInReturn({ pattern: `${FIXTURES}/clean-route.ts`, layer: 'routes' }),
    ).resolves.toBeUndefined()
  })

  it('fails on a loader that spreads the entity', async () => {
    await expect(
      assertNoEntitySpreadInReturn({ pattern: `${FIXTURES}/leaky-loader.ts`, layer: 'routes' }),
    ).rejects.toThrow(/object-literal spread/)
  })

  it('fails on an action that spreads the entity', async () => {
    await expect(
      assertNoEntitySpreadInReturn({ pattern: `${FIXTURES}/leaky-action.ts`, layer: 'routes' }),
    ).rejects.toThrow(/object-literal spread/)
  })

  it('throws (no vacuous pass) when the pattern matches no files', async () => {
    await expect(
      assertNoEntitySpreadInReturn({ pattern: `${FIXTURES}/nonexistent/**/*.ts` }),
    ).rejects.toThrow(/No files matched/)
  })
})
