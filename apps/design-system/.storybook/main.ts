import type { StorybookConfig } from '@storybook/react-vite'

/**
 * Storybook is the showcase for `packages/ui` and the design tokens (ADR-0014).
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
  typescript: {
    reactDocgen: 'react-docgen-typescript',
  },
}

export default config
