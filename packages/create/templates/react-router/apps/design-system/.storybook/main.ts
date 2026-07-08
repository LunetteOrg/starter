import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StorybookConfig } from '@storybook/react-vite'

// The Product/* pages import PDR markdown from the repo-root `docs/product/`
// (`?raw`), which is outside this app. Allow the dev server to read it.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * Storybook is the showcase for `packages/ui` and the design tokens (ADR-0006 — design tokens).
 * Stories live next to the components in `packages/ui`; this app aggregates
 * them and adds the local Foundations pages.
 */
const config: StorybookConfig = {
  stories: [
    // Local pages (Welcome, Foundations)
    '../src/**/*.mdx',
    '../src/**/*.stories.@(ts|tsx)',
    // Stories co-located in the shared UI package
    '../../../packages/ui/src/**/*.mdx',
    '../../../packages/ui/src/**/*.stories.@(ts|tsx)',
  ],
  addons: [
    '@storybook/addon-docs',
    '@storybook/addon-a11y',
    {
      name: 'storybook-design-token',
      options: {
        // Glob relative to the app root: reads the tokens from @starter/ui-tokens
        designTokenGlob: '../../packages/ui-tokens/**/*.css',
      },
    },
  ],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  viteFinal: (config) => ({
    ...config,
    server: {
      ...config.server,
      fs: { ...config.server?.fs, allow: [...(config.server?.fs?.allow ?? []), repoRoot] },
    },
  }),
  typescript: {
    reactDocgen: 'react-docgen-typescript',
  },
}

export default config
