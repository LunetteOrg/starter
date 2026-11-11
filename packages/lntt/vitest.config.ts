import { defineConfig } from 'vitest/config'

// The unit tests of lntt: one *.spec.ts beside each module, with the in-memory layers of the
// services it uses (docs/adr/effect-in-lntt.md#tests-beside-each-module). The end-to-end tests
// in test/ run on node:test, at the cli level.
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
  },
})
