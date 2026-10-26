import { defineConfig } from '@playwright/test'
import { viteUrl } from './e2e/stack-ports.ts'

const signInFiles = ['sso.spec.ts', 'team.spec.ts']
const signInProjectOf = (file: string) => `sign-in-${file.replace('.spec.ts', '')}`
const signInProjects = signInFiles.map((file, index) => ({
  name: signInProjectOf(file),
  testDir: 'e2e/01-access',
  testMatch: file,
  fullyParallel: false,
  dependencies: [index === 0 ? 'platform' : signInProjectOf(signInFiles[index - 1] ?? '')],
}))

export default defineConfig({
  fullyParallel: true,
  workers: Number(process.env.WORKERS ?? 3),
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 15_000, toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.01 } },
  retries: 0,
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
    ...signInProjects,
    {
      name: 'e2e',
      testDir: 'e2e',
      testIgnore: ['00-platform/**', ...signInFiles.map((file) => `01-access/${file}`)],
      dependencies: ['platform', signInProjectOf(signInFiles.at(-1) ?? '')],
    },
    { name: 'ui', testDir: 'ui' },
  ],
})
