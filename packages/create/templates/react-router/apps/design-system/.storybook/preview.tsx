import type { Preview } from '@storybook/react-vite'
import '@starter/ui-tokens/fonts.css'
import '@starter/ui-tokens/tokens.css'

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    a11y: {
      // 'todo' = axe violations reported but non-blocking.
      // Switch to 'error' to fail the build on violations (ADR-0006 — Storybook showcase).
      test: 'todo',
    },
  },
}

export default preview
