// @ts-nocheck — fake imports for arch boundary test fixtures
import { expect, it } from 'vitest'
import { another } from '~/forbidden/other'

it('does nothing', () => {
  expect(true).toBe(true)
})
