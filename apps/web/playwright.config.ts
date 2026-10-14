import { defineConfig } from '@playwright/test'
import { viteUrl } from './e2e/stack-ports.ts'

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  workers: Number(process.env.WORKERS ?? 2),
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [
    ['list'],
    [
      'json',
      {
        outputFile: new URL('../../.check/e2e-results.json', import.meta.url).pathname,
      },
    ],
  ],
  use: { baseURL: viteUrl, timezoneId: 'UTC', screenshot: 'only-on-failure' },
})
