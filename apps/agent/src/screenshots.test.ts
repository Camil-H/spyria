import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createScreenshotTaker } from './screenshots.ts'

const scratch = mkdtempSync(join(tmpdir(), 'spyria-screenshots-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const stubBrowserDirectory = new URL('../fixtures/stub-browser/', import.meta.url).pathname
const browserOf = () => {
  const logDirectory = mkdtempSync(join(scratch, 'browser-'))
  const linesOf = (file: string) =>
    existsSync(join(logDirectory, file)) ? readFileSync(join(logDirectory, file), 'utf8').trim().split('\n') : []
  return {
    env: (install = '') => ({ PATH: String(process.env.PATH), STUB_INSTALL: install, STUB_BROWSER_LOG: logDirectory }),
    installs: () => linesOf('installs').length,
    captures: () => linesOf('captures').map((line) => JSON.parse(line)),
  }
}
const workspaceOf = () => mkdtempSync(join(scratch, 'workspace-'))
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
  const takeScreenshot = createScreenshotTaker(stubBrowserDirectory)

  expect(await takeScreenshot(root, request(), browser.env())).toEqual({ path: '.spyria/screenshots/home.png' })
  expect(
    await takeScreenshot(
      root,
      request({ name: 'home-dark', viewport: 'mobile', fullPage: true, theme: 'dark' }),
      browser.env(),
    ),
  ).toEqual({ path: '.spyria/screenshots/home-dark.png' })
  expect(readFileSync(join(root, '.spyria/screenshots/home.png')).subarray(1, 4).toString()).toBe('PNG')
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
  const takeScreenshot = createScreenshotTaker(stubBrowserDirectory, { captureTimeoutMilliseconds: 300 })

  expect(await takeScreenshot(root, request({ url: 'http://localhost:9/refused' }), browser.env())).toEqual({
    failure:
      'The screenshot of http://localhost:9/refused failed: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:9/refused',
  })
  expect(await takeScreenshot(root, request({ url: 'http://localhost:3000/slow' }), browser.env())).toEqual({
    failure: 'The screenshot of http://localhost:3000/slow failed: it took longer than 0.3 seconds',
  })
  expect(await takeScreenshot(root, request({ url: 'http://localhost:3000/huge' }), browser.env())).toEqual({
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
    expect(await takeScreenshot(root, request(invalid), browser.env())).toEqual({
      failure: 'The screenshot request is not valid',
    })
  expect(browser.captures()).toHaveLength(capturedBefore)
})

test('while Chromium installs past the wait the call answers to try again as the install carries on, and a failed install is tried again on the next call', async () => {
  const browser = browserOf()
  const root = workspaceOf()
  const takeScreenshot = createScreenshotTaker(stubBrowserDirectory, { installWaitMilliseconds: 100 })

  expect(await takeScreenshot(root, request(), browser.env('slow'))).toEqual({
    failure: 'Chromium is still being installed for screenshots, once per runtime: try again in a minute',
  })
  await Bun.sleep(500)
  expect(await takeScreenshot(root, request(), browser.env())).toEqual({ path: '.spyria/screenshots/home.png' })
  expect(browser.installs()).toBe(1)

  const failing = browserOf()
  const takeAfterFailure = createScreenshotTaker(stubBrowserDirectory)
  expect(await takeAfterFailure(root, request(), failing.env('fail'))).toEqual({
    failure: 'Installing Chromium for screenshots failed: download failed: no network',
  })
  expect(await takeAfterFailure(root, request(), failing.env())).toEqual({ path: '.spyria/screenshots/home.png' })
  expect(failing.installs()).toBe(1)
})
