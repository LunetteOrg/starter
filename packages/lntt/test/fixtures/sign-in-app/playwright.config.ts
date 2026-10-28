import { defineConfig } from '@playwright/test'

export default defineConfig({ testDir: './e2e', testMatch: '**/*.setup.ts', reporter: 'line' })
