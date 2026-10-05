import { defineConfig } from '@playwright/test'
import { viteUrl } from './e2e/stack-ports.ts'

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  workers: Number(process.env.WORKERS ?? 2),
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: viteUrl, timezoneId: 'UTC', trace: 'retain-on-failure' },
})
