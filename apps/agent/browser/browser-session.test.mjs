import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserSession, screenshotOptionsOf } from './browser-session.mjs'

const directory = mkdtempSync(join(tmpdir(), 'spyria-browser-session-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const fakePage = ({ size = { width: 1280, height: 800 } } = {}) => {
  const handlers = new Map()
  const screenshots = []
  return {
    handlers,
    screenshots,
    on: (event, handler) => handlers.set(event, handler),
    url: () => 'https://example.com/',
    title: async () => 'Example',
    bringToFront: async () => {},
    isClosed: () => false,
    mainFrame: () => undefined,
    evaluate: async () => size,
    screenshot: async (options) => {
      screenshots.push(options)
      return Buffer.from('jpeg')
    },
  }
}
const sessionOn = (page, settings = { downloads: true, uploads: true }) => {
  const sent = []
  const context = { on: () => {}, pages: () => [page], newPage: async () => page }
  const session = createBrowserSession({ context, send: (message) => sent.push(message), settings: () => settings })
  return { session, sent }
}
const downloadOf = (bytes) => {
  const path = join(directory, `file-${bytes}`)
  writeFileSync(path, Buffer.alloc(bytes, 1))
  const download = {
    isCancelled: false,
    isDeleted: false,
    path: async () => path,
    suggestedFilename: () => 'report.pdf',
    cancel: async () => {
      download.isCancelled = true
    },
    delete: async () => {
      download.isDeleted = true
    },
  }
  return download
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 20))

test('a download up to 3 MB goes to the member, a larger one is refused, and none when downloads are off', async () => {
  const page = fakePage()
  const { sent } = sessionOn(page)
  const small = downloadOf(1024)
  page.handlers.get('download')(small)
  const large = downloadOf(3 * 1024 * 1024 + 1)
  page.handlers.get('download')(large)
  await settled()
  expect(sent).toHaveLength(2)
  expect(sent).toContainEqual({ type: 'download', name: 'report.pdf', data: Buffer.alloc(1024, 1).toString('base64') })
  expect(sent).toContainEqual({ type: 'notice', text: 'report.pdf is over 3 MB, so it was not downloaded' })
  expect([small.isDeleted, large.isDeleted]).toEqual([true, true])

  const offPage = fakePage()
  const off = sessionOn(offPage, { downloads: false, uploads: true })
  const refused = downloadOf(10)
  offPage.handlers.get('download')(refused)
  await settled()
  expect(refused.isCancelled).toBe(true)
  expect(off.sent).toEqual([{ type: 'notice', text: 'Downloads are turned off in this workspace' }])
})

test('a full-page screenshot is cut at 10,000 pixels on each side, and a screen-sized one is taken as it is', async () => {
  expect(screenshotOptionsOf(true, { width: 1280, height: 50_000 })).toEqual({
    type: 'jpeg',
    quality: 70,
    fullPage: true,
    clip: { x: 0, y: 0, width: 1280, height: 10_000 },
  })
  expect(screenshotOptionsOf(true, { width: 30_000, height: 900 }).clip).toEqual({
    x: 0,
    y: 0,
    width: 10_000,
    height: 900,
  })
  expect(screenshotOptionsOf(true, { width: 1280, height: 4000 })).toEqual({
    type: 'jpeg',
    quality: 70,
    fullPage: true,
  })
  expect(screenshotOptionsOf(false, { width: 0, height: 0 })).toEqual({ type: 'jpeg', quality: 70, fullPage: false })

  const page = fakePage({ size: { width: 1280, height: 50_000 } })
  const { session, sent } = sessionOn(page)
  await session.receive({ id: 1, command: 'screenshot', fullPage: true })
  expect(page.screenshots).toEqual([screenshotOptionsOf(true, { width: 1280, height: 50_000 })])
  expect(sent.find(({ id }) => id === 1)).toEqual({
    id: 1,
    result: { text: 'Screenshot of Example (https://example.com/)', image: Buffer.from('jpeg').toString('base64') },
  })
})
