import type { StorybookConfig } from '@storybook/react-vite'

/**
 * Storybook è la vetrina di `packages/ui` e dei design token (ADR-0014).
 * Le storie vivono accanto ai componenti in `packages/ui`; questa app le
 * aggrega e aggiunge le pagine Foundations locali.
 */
const config: StorybookConfig = {
  stories: [
    // Pagine locali (Welcome, Foundations)
    '../src/**/*.mdx',
    '../src/**/*.stories.@(ts|tsx)',
    // Storie co-locate nel package UI condiviso
    '../../../packages/ui/src/**/*.mdx',
    '../../../packages/ui/src/**/*.stories.@(ts|tsx)',
  ],
  addons: [
    '@storybook/addon-docs',
    '@storybook/addon-a11y',
    {
      name: 'storybook-design-token',
      options: {
        // Glob relativo alla root dell'app: legge i token da @starter/ui-tokens
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
