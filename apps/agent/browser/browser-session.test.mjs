import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserSession, removeFilesOlderThan, screenshotOptionsOf } from './browser-session.mjs'

const directory = mkdtempSync(join(tmpdir(), 'spyria-browser-session-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const filesDirectoryOf = () => mkdtempSync(join(directory, 'files-'))

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
const sessionOn = (
  page,
  { settings = { downloads: true, uploads: true }, filesDirectory = filesDirectoryOf() } = {},
) => {
  const sent = []
  const context = { on: () => {}, pages: () => [page], newPage: async () => page }
  const session = createBrowserSession({
    context,
    send: (message) => sent.push(message),
    settings: () => settings,
    filesDirectory,
  })
  return { session, sent, filesDirectory }
}
const downloadOf = (bytes) => {
  const path = join(directory, `download-${crypto.randomUUID()}`)
  writeFileSync(path, Buffer.alloc(bytes, 1))
  const download = {
    isCancelled: false,
    path: async () => path,
    suggestedFilename: () => 'video.mp4',
    cancel: async () => {
      download.isCancelled = true
    },
    delete: async () => rmSync(path, { force: true }),
  }
  return download
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 20))

test('a download is handed over as a file of the browser, with only its id, name and size on the stream, whatever its size', async () => {
  const page = fakePage()
  const { session, sent, filesDirectory } = sessionOn(page)
  page.handlers.get('download')(downloadOf(64 * 1024 * 1024))
  await settled()
  expect(sent).toEqual([
    { type: 'download', file: expect.stringMatching(/^[a-f0-9]{32}$/), name: 'video.mp4', size: 64 * 1024 * 1024 },
  ])
  const { file } = sent[0]
  expect(readdirSync(filesDirectory)).toEqual([file])
  expect(JSON.stringify(sent).length).toBeLessThan(200)

  await session.receive({ type: 'file_read', file })
  expect(readdirSync(filesDirectory)).toEqual([])
})

test('with downloads off, a download is cancelled and the member is told', async () => {
  const page = fakePage()
  const { sent, filesDirectory } = sessionOn(page, { settings: { downloads: false, uploads: true } })
  const refused = downloadOf(10)
  page.handlers.get('download')(refused)
  await settled()
  expect(refused.isCancelled).toBe(true)
  expect(sent).toEqual([{ type: 'notice', text: 'Downloads are turned off in this workspace' }])
  expect(readdirSync(filesDirectory)).toEqual([])
})

test('a file the member asks to remove is removed only by its id, never by a path', async () => {
  const filesDirectory = filesDirectoryOf()
  const kept = join(directory, 'kept.txt')
  writeFileSync(kept, 'keep')
  const { session } = sessionOn(fakePage(), { filesDirectory })
  await session.receive({ type: 'file_read', file: '../kept.txt' })
  expect(existsSync(kept)).toBe(true)
})

test('a full-page screenshot is cut at 10,000 pixels on each side, and a screen-sized one is taken as it is', () => {
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
})

test('a screenshot is handed over as a file of the browser, its answer naming the file', async () => {
  const page = fakePage({ size: { width: 1280, height: 50_000 } })
  const { session, sent, filesDirectory } = sessionOn(page)
  await session.receive({ id: 1, command: 'screenshot', fullPage: true })
  expect(page.screenshots).toEqual([screenshotOptionsOf(true, { width: 1280, height: 50_000 })])
  const answer = sent.find(({ id }) => id === 1)
  expect(answer).toEqual({
    id: 1,
    result: {
      text: 'Screenshot of Example (https://example.com/)',
      imageFile: expect.stringMatching(/^[a-f0-9]{32}$/),
    },
  })
  expect(readFileSync(join(filesDirectory, answer.result.imageFile), 'utf8')).toBe('jpeg')
})

test('files nobody fetched are removed once they are older than their lifetime', async () => {
  const filesDirectory = filesDirectoryOf()
  writeFileSync(join(filesDirectory, 'old'), 'x')
  writeFileSync(join(filesDirectory, 'new'), 'x')
  const now = Date.now()
  utimesSync(join(filesDirectory, 'old'), new Date(now - 60_000), new Date(now - 60_000))
  await removeFilesOlderThan(filesDirectory, 30_000, now)
  expect(readdirSync(filesDirectory)).toEqual(['new'])
})
