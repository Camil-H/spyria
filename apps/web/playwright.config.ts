import { defineConfig } from '@playwright/test'
import { viteUrl } from './e2e/stack-ports.ts'

const signInFiles = ['sso.spec.ts', 'team.spec.ts', 'sessions.spec.ts', 'workspaces.spec.ts']

export default defineConfig({
  fullyParallel: true,
  workers: Number(process.env.WORKERS ?? 3),
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['./e2e/platform-gate.ts'],
    [
      'json',
      {
        outputFile: new URL('../../.check/e2e-results.json', import.meta.url).pathname,
      },
    ],
  ],
  use: { baseURL: viteUrl, timezoneId: 'UTC', screenshot: 'only-on-failure' },
  projects: [
    { name: 'platform', testDir: 'e2e/00-platform' },
    {
      name: 'sign-in',
      testDir: 'e2e/01-access',
      testMatch: signInFiles,
      fullyParallel: false,
      workers: 1,
      dependencies: ['platform'],
    },
    {
      name: 'e2e',
      testDir: 'e2e',
      testIgnore: ['00-platform/**', ...signInFiles.map((file) => `01-access/${file}`)],
      dependencies: ['platform'],
    },
  ],
})
