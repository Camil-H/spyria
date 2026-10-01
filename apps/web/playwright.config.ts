import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  use: { baseURL: 'http://localhost:5173' },
  webServer: { command: 'bun run dev', url: 'http://localhost:5173', reuseExistingServer: true },
})
