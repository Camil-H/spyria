import { randomBytes } from 'node:crypto'
import { readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const commandTimeoutMilliseconds = 30_000
const maximumWaitSeconds = 30
const maximumSnapshotCharacters = 60_000
const maximumResultCharacters = 20_000
const maximumFilesBytes = 4 * 1024 ** 3
const maximumFrameCharacters = 2 * 1024 * 1024
const fileIdPattern = /^[a-f0-9]{32}$/
const maximumScreenshotSide = 10_000
const maximumTitleCharacters = 300
const screencastQuality = 70
const viewportRange = { width: [320, 2560], height: [240, 1600] }
const mouseButtons = ['left', 'middle', 'right']
const submitWords = /\b(buy|pay|order|purchase|checkout|check out|subscribe|confirm|place|send|submit|book|donate)\b/i

export const screenshotOptionsOf = (fullPage, page) => {
  const isCut = fullPage && (page.width > maximumScreenshotSide || page.height > maximumScreenshotSide)
  const clip = {
    x: 0,
    y: 0,
    width: Math.min(page.width, maximumScreenshotSide),
    height: Math.min(page.height, maximumScreenshotSide),
  }
  return { type: 'jpeg', quality: 70, fullPage, ...(isCut && { clip }) }
}

const newFileId = () => randomBytes(16).toString('hex')

export const bytesIn = async (directory) => {
  let total = 0
  for (const name of await readdir(directory).catch(() => []))
    total += (await stat(join(directory, name)).catch(() => ({ size: 0 }))).size
  return total
}

export const removeFilesOlderThan = async (directory, maximumAgeMilliseconds, now = Date.now()) => {
  for (const name of await readdir(directory).catch(() => [])) {
    const path = join(directory, name)
    const { mtimeMs } = await stat(path).catch(() => ({ mtimeMs: now }))
    if (now - mtimeMs >= maximumAgeMilliseconds) await unlink(path).catch(() => {})
  }
}

const firstLineOf = (error) => String(error?.message ?? error).split('\n')[0]
const clamp = (value, [minimum, maximum]) => Math.min(maximum, Math.max(minimum, Math.round(Number(value) || 0)))
const truncated = (text, maximum) =>
  text.length > maximum ? `${text.slice(0, maximum)}\n[cut at ${maximum} characters]` : text
const isWebUrl = (url) => url.startsWith('http://') || url.startsWith('https://')
const modifiersOf = ({ alt, control, meta, shift }) =>
  (alt ? 1 : 0) | (control ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0)

const wouldSubmitInPage = (element, { action, key = '', submitPattern }) => {
  const form = element.closest('form')
  const isEditable = element.isContentEditable || element.tagName === 'INPUT' || element.tagName === 'TEXTAREA'
  if (action === 'press' && /(^|\+)(Enter|NumpadEnter)$/.test(key) && isEditable) return true
  const control = element.closest('button, input, a, [role="button"]')
  if (!control) return false
  const type = (control.getAttribute('type') ?? (control.tagName === 'BUTTON' ? 'submit' : '')).toLowerCase()
  if (form !== null && (type === 'submit' || type === 'image')) return true
  const label = `${control.textContent ?? ''} ${control.getAttribute('aria-label') ?? ''} ${control.getAttribute('value') ?? ''}`
  return control.tagName !== 'A' && new RegExp(submitPattern, 'i').test(label)
}

export const createBrowserSession = ({
  context,
  send,
  settings,
  blockOf,
  filesDirectory,
  filesBudgetBytes = maximumFilesBytes,
}) => {
  let activePage
  let screencast
  let isWatched = false
  let fileChooser
  const titleOf = async (page) => (await page.title().catch(() => '')).slice(0, maximumTitleCharacters)
  const sendPage = async (page) => {
    if (page !== activePage) return
    send({ type: 'page', url: page.url(), title: await titleOf(page) })
  }
  const stopScreencast = async () => {
    const current = screencast
    screencast = undefined
    await current?.session.send('Page.stopScreencast').catch(() => {})
    await current?.session.detach().catch(() => {})
  }
  const startScreencast = async () => {
    await stopScreencast()
    if (!isWatched || !activePage) return
    const page = activePage
    const session = await context.newCDPSession(page)
    const current = { session, page, pendingAcknowledgement: undefined }
    screencast = current
    session.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      if (screencast !== current) return
      if (data.length > maximumFrameCharacters)
        return void session.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
      current.pendingAcknowledgement = sessionId
      send({ type: 'frame', data, width: metadata.deviceWidth, height: metadata.deviceHeight })
    })
    const { width, height } = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    await session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: screencastQuality,
      maxWidth: width,
      maxHeight: height,
    })
  }
  const acknowledgeFrame = async () => {
    const current = screencast
    const sessionId = current?.pendingAcknowledgement
    if (!current || sessionId === undefined) return
    current.pendingAcknowledgement = undefined
    await current.session.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
  }
  const activate = async (page) => {
    activePage = page
    await page.bringToFront().catch(() => {})
    await sendPage(page)
    await startScreencast()
  }
  const activeDownloads = new Set()
  const sendDownload = async (download) => {
    if (!settings().downloads) {
      await download.cancel()
      return send({ type: 'notice', text: 'Downloads are turned off in this workspace' })
    }
    activeDownloads.add(download)
    const path = await download.path().catch(() => null)
    activeDownloads.delete(download)
    if (!path) return
    const { size } = await stat(path)
    if ((await bytesIn(filesDirectory)) > filesBudgetBytes) {
      await download.delete().catch(() => {})
      return send({
        type: 'notice',
        text: `${download.suggestedFilename()} was not kept: downloads waiting in this browser are over 4 GB`,
      })
    }
    const file = newFileId()
    await rename(path, join(filesDirectory, file))
    send({ type: 'download', file, name: download.suggestedFilename(), size })
  }
  const enforceFilesBudget = async () => {
    if (activeDownloads.size === 0 || (await bytesIn(filesDirectory)) <= filesBudgetBytes) return
    const cancelled = [...activeDownloads]
    activeDownloads.clear()
    for (const download of cancelled) {
      await download.cancel().catch(() => {})
      send({
        type: 'notice',
        text: `${download.suggestedFilename()} was stopped: downloads waiting in this browser are over 4 GB`,
      })
    }
  }
  const watchPage = (page) => {
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return
      if (isWebUrl(frame.url())) send({ type: 'visited', url: frame.url() })
      void sendPage(page)
    })
    page.on('load', () => void sendPage(page))
    page.on('download', (download) => void sendDownload(download).catch(() => {}))
    page.on('filechooser', (chooser) => {
      if (!settings().uploads) return send({ type: 'notice', text: 'Uploads are turned off in this workspace' })
      fileChooser = chooser
      send({ type: 'file_chooser', multiple: chooser.isMultiple() })
    })
    page.on('close', () => {
      if (page !== activePage) return
      const [next] = context.pages().slice(-1)
      if (next) return void activate(next)
      void context.newPage().catch(() => {})
    })
  }
  context.on('page', (page) => {
    watchPage(page)
    void activate(page)
  })
  const pageNow = async () => {
    if (activePage && !activePage.isClosed()) return activePage
    const [existing] = context.pages()
    const page = existing ?? (await context.newPage())
    if (existing) await activate(existing)
    return page
  }
  const blockedHostOf = (url) => {
    const host = URL.canParse(url) ? new URL(url).hostname : ''
    const block = blockOf(host)
    return block && `${host} ${block}`
  }
  const goTo = async (url) => {
    const page = await pageNow()
    const response = await page
      .goto(url, { waitUntil: 'domcontentloaded', timeout: commandTimeoutMilliseconds })
      .catch((error) => {
        throw new Error(blockedHostOf(url) || firstLineOf(error))
      })
    const blocked = response?.status() === 403 && blockedHostOf(url)
    if (blocked) throw new Error(blocked)
    return page
  }
  const describe = async (page) => `${(await titleOf(page)) || 'Untitled'} (${page.url()})`
  const elementOf = async (ref) => (await pageNow()).getByRef(String(ref))
  const commands = {
    open: async ({ url }) => `Opened ${await describe(await goTo(String(url)))}`,
    snapshot: async () => {
      const page = await pageNow()
      const snapshot = await page.ariaSnapshot({ mode: 'ai', timeout: commandTimeoutMilliseconds })
      return `${await describe(page)}\n${truncated(snapshot, maximumSnapshotCharacters)}`
    },
    click: async ({ ref, double }) => {
      await (await elementOf(ref))[double ? 'dblclick' : 'click']({ timeout: commandTimeoutMilliseconds })
      return `Clicked ${ref}; the page is now ${await describe(await pageNow())}`
    },
    type: async ({ ref, text, submit }) => {
      const element = await elementOf(ref)
      await element.pressSequentially(String(text), { timeout: commandTimeoutMilliseconds })
      if (submit) await element.press('Enter')
      return `Typed into ${ref}`
    },
    fill: async ({ ref, value }) => {
      await (await elementOf(ref)).fill(String(value), { timeout: commandTimeoutMilliseconds })
      return `Filled ${ref}`
    },
    press: async ({ key, ref }) => {
      if (ref) await (await elementOf(ref)).press(String(key), { timeout: commandTimeoutMilliseconds })
      else await (await pageNow()).keyboard.press(String(key))
      return `Pressed ${key}`
    },
    evaluate: async ({ expression }) => {
      const result = await (await pageNow()).evaluate(String(expression))
      return truncated(JSON.stringify(result) ?? 'undefined', maximumResultCharacters)
    },
    wait: async ({ text, seconds }) => {
      const page = await pageNow()
      const waitSeconds = Math.min(maximumWaitSeconds, Math.max(0, Number(seconds) || 0))
      if (!text) {
        await page.waitForTimeout(waitSeconds * 1000)
        return `Waited ${waitSeconds} seconds`
      }
      await page
        .getByText(String(text))
        .first()
        .waitFor({ timeout: (waitSeconds || maximumWaitSeconds) * 1000 })
      return `"${text}" shows on ${await describe(page)}`
    },
    navigate: async ({ direction }) => {
      const page = await pageNow()
      const options = { waitUntil: 'domcontentloaded', timeout: commandTimeoutMilliseconds }
      if (direction === 'back') await page.goBack(options)
      else if (direction === 'forward') await page.goForward(options)
      else await page.reload(options)
      return `Went ${direction}; the page is now ${await describe(page)}`
    },
    screenshot: async ({ fullPage }) => {
      const page = await pageNow()
      const size = fullPage
        ? await page.evaluate(() => ({
            width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
            height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
          }))
        : { width: 0, height: 0 }
      const imageFile = newFileId()
      await writeFile(
        join(filesDirectory, imageFile),
        await page.screenshot(screenshotOptionsOf(fullPage === true, size)),
      )
      return { text: `Screenshot of ${await describe(page)}`, imageFile }
    },
    would_submit: async ({ action, ref, key }) =>
      (await elementOf(ref)).evaluate(
        wouldSubmitInPage,
        { action, key, submitPattern: submitWords.source },
        { timeout: commandTimeoutMilliseconds },
      ),
  }
  const dispatchMouse = async (page, { action, x, y, button, clickCount, deltaX, deltaY, ...modifiers }) => {
    const session = screencast?.page === page ? screencast.session : await context.newCDPSession(page)
    const type = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased', wheel: 'mouseWheel' }[action]
    if (!type) return
    await session.send('Input.dispatchMouseEvent', {
      type,
      x: Number(x) || 0,
      y: Number(y) || 0,
      button: action === 'move' || action === 'wheel' ? 'none' : mouseButtons.includes(button) ? button : 'left',
      clickCount: action === 'down' || action === 'up' ? Math.min(3, Math.max(1, Number(clickCount) || 1)) : 0,
      deltaX: Number(deltaX) || 0,
      deltaY: Number(deltaY) || 0,
      modifiers: modifiersOf(modifiers),
    })
  }
  const memberActions = {
    input: async ({ event }) => {
      const page = await pageNow()
      if (event?.kind === 'mouse') return dispatchMouse(page, event)
      if (event?.kind === 'key' && event.action === 'down') return page.keyboard.down(String(event.key))
      if (event?.kind === 'key' && event.action === 'up') return page.keyboard.up(String(event.key))
      if (event?.kind === 'text') return page.keyboard.insertText(String(event.text))
    },
    go_to: async ({ url }) => {
      await goTo(String(url))
    },
    go: async ({ direction }) => {
      await commands.navigate({ direction })
    },
    resize: async ({ width, height }) => {
      const page = await pageNow()
      const session = await context.newCDPSession(page)
      const { windowId } = await session.send('Browser.getWindowForTarget')
      const frame = await page.evaluate(() => ({
        width: outerWidth - innerWidth,
        height: outerHeight - innerHeight,
      }))
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: {
          windowState: 'normal',
          width: clamp(width, viewportRange.width) + frame.width,
          height: clamp(height, viewportRange.height) + frame.height,
        },
      })
      await session.detach().catch(() => {})
      await startScreencast()
    },
    files: async ({ files }) => {
      const chooser = fileChooser
      fileChooser = undefined
      if (!chooser || !settings().uploads || !Array.isArray(files)) return
      await chooser.setFiles(
        files.map(({ name, mimeType, data }) => ({
          name: String(name),
          mimeType: String(mimeType || 'application/octet-stream'),
          buffer: Buffer.from(String(data), 'base64'),
        })),
      )
    },
    watch: async () => {
      isWatched = true
      await sendPage(await pageNow())
      await startScreencast()
    },
    unwatch: async () => {
      isWatched = false
      await stopScreencast()
    },
    frame_ack: acknowledgeFrame,
    file_read: async ({ file }) => {
      if (fileIdPattern.test(String(file))) await unlink(join(filesDirectory, String(file))).catch(() => {})
    },
  }
  for (const page of context.pages()) watchPage(page)
  return {
    enforceFilesBudget,
    reset: async () => {
      isWatched = false
      fileChooser = undefined
      await stopScreencast()
    },
    start: async () => {
      await activate(context.pages()[0] ?? (await context.newPage()))
    },
    receive: async (message) => {
      if (typeof message?.command === 'string') {
        const run = commands[message.command]
        if (!run) return send({ id: message.id, error: 'Unknown browser command' })
        return run(message).then(
          (result) => send({ id: message.id, result }),
          (error) => send({ id: message.id, error: firstLineOf(error) }),
        )
      }
      await memberActions[message?.type]?.(message).catch((error) => send({ type: 'notice', text: firstLineOf(error) }))
    },
  }
}
