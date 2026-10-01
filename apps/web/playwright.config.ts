import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  use: { baseURL: 'http://localhost:5173', timezoneId: 'UTC' },
  webServer: { command: 'bun run dev', url: 'http://localhost:5173', reuseExistingServer: true },
})
