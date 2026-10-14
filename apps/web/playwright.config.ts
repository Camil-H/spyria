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
        outputFile: new URL(`../../.check/${process.env.HQ_E2E_RESULTS ?? 'e2e-results.json'}`, import.meta.url)
          .pathname,
      },
    ],
  ],
  use: { baseURL: viteUrl, timezoneId: 'UTC', screenshot: 'only-on-failure' },
  projects: [
    { name: 'stack', grepInvert: /@docker/ },
    { name: 'docker', grep: /@docker/, workers: 1, timeout: 180_000, expect: { timeout: 90_000 } },
  ],
})
