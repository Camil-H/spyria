import { defineConfig } from '@playwright/test'
import { viteUrl } from './e2e-zero/stack-ports.ts'

process.env.HQ_E2E_DATA = 'zero'

export default defineConfig({
  testDir: '.',
  testMatch: /^.*\/e2e(-zero)?\/.+\.spec\.ts$/,
  fullyParallel: true,
  workers: Number(process.env.WORKERS ?? 2),
  globalSetup: './e2e-zero/global-setup.ts',
  use: { baseURL: viteUrl, timezoneId: 'UTC', trace: 'retain-on-failure' },
})
