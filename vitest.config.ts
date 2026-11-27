import { defineConfig } from 'vitest/config'

// The unit level of the repo runs from here: each package keeps its own vitest settings in its
// vitest.config.ts, and this file only lists them (docs/adr/effect-in-lntt.md#tests-beside-each-module).
export default defineConfig({
  test: {
    projects: ['packages/lntt', 'packages/test-utils'],
  },
})
