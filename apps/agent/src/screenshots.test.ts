import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createScreenshotTaker } from './screenshots.ts'

const scratch = mkdtempSync(join(tmpdir(), 'spyria-screenshots-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const fakeBrowser = `import { appendFileSync, writeFileSync } from 'node:fs'
const log = (file, line) => appendFileSync(new URL(file, import.meta.url), line + '\\n')
const [command, request] = process.argv.slice(2)
if (command === 'install') {
  if (process.env.FAKE_INSTALL === 'slow') await new Promise((resolve) => setTimeout(resolve, 400))
  if (process.env.FAKE_INSTALL === 'fail') {
    console.error('download failed: no network')
    process.exit(1)
  }
  log('installs', 'installed')
} else {
  const { output, ...capture } = JSON.parse(request)
  if (capture.url.includes('refused')) {
    console.error('page.goto: net::ERR_CONNECTION_REFUSED at ' + capture.url + '\\nCall log: ...')
    process.exit(1)
  }
  if (capture.url.includes('slow')) await new Promise((resolve) => setTimeout(resolve, 5000))
  log('captures', JSON.stringify(capture))
  writeFileSync(output, capture.url.includes('huge') ? Buffer.alloc(21 * 1024 * 1024) : 'png')
}
`
const browserOf = () => {
  const directory = mkdtempSync(join(scratch, 'browser-'))
  writeFileSync(join(directory, 'screenshot.mjs'), fakeBrowser)
  const linesOf = (file: string) =>
    existsSync(join(directory, file)) ? readFileSync(join(directory, file), 'utf8').trim().split('\n') : []
  return {
    directory,
    installs: () => linesOf('installs').length,
    captures: () => linesOf('captures').map((line) => JSON.parse(line)),
  }
}
const workspaceOf = () => mkdtempSync(join(scratch, 'workspace-'))
const env = (fakeInstall = '') => ({ PATH: String(process.env.PATH), FAKE_INSTALL: fakeInstall })
const request = (fields: Record<string, unknown> = {}) => ({
  url: 'http://localhost:3000/',
  name: 'home',
  viewport: 'desktop',
  fullPage: false,
  theme: 'light',
  ...fields,
})

test('a screenshot is saved under .spyria/screenshots by its name and kept out of git, with Chromium installed once for every later screenshot', async () => {
  const browser = browserOf()
  const root = workspaceOf()
  const takeScreenshot = createScreenshotTaker(browser.directory)

  expect(await takeScreenshot(root, request(), env())).toEqual({ path: '.spyria/screenshots/home.png' })
  expect(
    await takeScreenshot(
      root,
      request({ name: 'home-dark', viewport: 'mobile', fullPage: true, theme: 'dark' }),
      env(),
    ),
  ).toEqual({ path: '.spyria/screenshots/home-dark.png' })
  expect(readFileSync(join(root, '.spyria/screenshots/home.png'), 'utf8')).toBe('png')
  expect(readFileSync(join(root, '.spyria/.gitignore'), 'utf8')).toBe('*\n')
  expect(browser.installs()).toBe(1)
  expect(browser.captures()).toEqual([
    { url: 'http://localhost:3000/', viewport: 'desktop', fullPage: false, theme: 'light' },
    { url: 'http://localhost:3000/', viewport: 'mobile', fullPage: true, theme: 'dark' },
  ])
})

test('a page that fails, takes too long or is too large answers why, and a request that is not valid never reaches Chromium', async () => {
  const browser = browserOf()
  const root = workspaceOf()
  const takeScreenshot = createScreenshotTaker(browser.directory, { captureTimeoutMilliseconds: 300 })

  expect(await takeScreenshot(root, request({ url: 'http://localhost:9/refused' }), env())).toEqual({
    failure:
      'The screenshot of http://localhost:9/refused failed: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:9/refused\nCall log: ...',
  })
  expect(await takeScreenshot(root, request({ url: 'http://localhost:3000/slow' }), env())).toEqual({
    failure: 'The screenshot of http://localhost:3000/slow failed: it took longer than 0.3 seconds',
  })
  expect(await takeScreenshot(root, request({ url: 'http://localhost:3000/huge' }), env())).toEqual({
    failure: 'The screenshot is larger than 20 MB: take it without the full page',
  })
  expect(existsSync(join(root, '.spyria/screenshots/home.png'))).toBe(false)
  const capturedBefore = browser.captures().length
  for (const invalid of [
    { name: '../escape' },
    { name: '' },
    { url: 'file:///etc/passwd' },
    { url: 'javascript:alert(1)' },
    { viewport: 'tablet' },
    { theme: 'sepia' },
    { fullPage: 'yes' },
  ])
    expect(await takeScreenshot(root, request(invalid), env())).toEqual({
      failure: 'The screenshot request is not valid',
    })
  expect(browser.captures()).toHaveLength(capturedBefore)
})

test('while Chromium installs past the wait the call answers to try again as the install carries on, and a failed install is tried again on the next call', async () => {
  const browser = browserOf()
  const root = workspaceOf()
  const takeScreenshot = createScreenshotTaker(browser.directory, { installWaitMilliseconds: 100 })

  expect(await takeScreenshot(root, request(), env('slow'))).toEqual({
    failure: 'Chromium is still being installed for screenshots, about 150 MB once per runtime: try again in a minute',
  })
  await Bun.sleep(500)
  expect(await takeScreenshot(root, request(), env())).toEqual({ path: '.spyria/screenshots/home.png' })
  expect(browser.installs()).toBe(1)

  const failing = browserOf()
  const takeAfterFailure = createScreenshotTaker(failing.directory)
  expect(await takeAfterFailure(root, request(), env('fail'))).toEqual({
    failure: 'Installing Chromium for screenshots failed: download failed: no network',
  })
  expect(await takeAfterFailure(root, request(), env())).toEqual({ path: '.spyria/screenshots/home.png' })
  expect(failing.installs()).toBe(1)
})
