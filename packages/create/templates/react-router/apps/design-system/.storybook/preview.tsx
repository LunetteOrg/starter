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
      // 'error' = an axe violation FAILS `pnpm test`, in the browser run and in
      // the Storybook UI alike (ADR-0006 — Storybook showcase). This is what
      // makes "a component is not done without an a11y pass" enforceable rather
      // than aspirational. Drop to 'todo' to report violations without blocking.
      test: 'error',
    },
  },
}

export default preview
