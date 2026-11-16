import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { createBrowserSession, removeFilesOlderThan } from './browser-session.mjs'
import { blockReasons, createPolicyProxy } from './network-policy.mjs'
import { createLineWriter } from './output-lines.mjs'

process.env.PLAYWRIGHT_BROWSERS_PATH ??= new URL('./chromium', import.meta.url).pathname
const { chromium } = await import('playwright-core')

const display = ':99'
const screenSize = '2560x1600x24'
const initialWindow = { width: 1280, height: 800 }
const browserDirectory = process.env.SPYRIA_BROWSER_DIRECTORY ?? '/var/lib/spyria/browser'
const profileDirectory = `${browserDirectory}/profile`
const filesDirectory = `${browserDirectory}/files`
const fileLifetimeMilliseconds = 30 * 60_000
const fileSweepMilliseconds = 5 * 60_000
const displayWaitMilliseconds = 10_000
const blockMemoryMilliseconds = 30_000
const hostMachineName = 'host.docker.internal'

const send = createLineWriter({ write: (line) => process.stdout.write(`${line}\n`) })
const fail = (error) => {
  send({ type: 'failed', error: String(error?.message ?? error).split('\n')[0] })
  process.exit(1)
}

const messages = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
const pending = []
let receive = (message) => pending.push(message)
let reset = async () => {}
let current
let isReady = false
const firstSettings = new Promise((resolve) => {
  messages.on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message?.type === 'settings') {
      current = message.settings
      if (isReady) void reset().finally(() => send({ type: 'ready' }))
      return resolve()
    }
    receive(message)
  })
})
messages.on('close', () => process.exit(0))
await firstSettings

const startDisplay = async () => {
  const server = spawn('Xvfb', [display, '-screen', '0', screenSize, '-nolisten', 'tcp', '-nolisten', 'local'], {
    stdio: 'ignore',
  })
  server.on('exit', () => fail(new Error('The virtual display stopped')))
  const socket = `/tmp/.X11-unix/X${display.slice(1)}`
  const deadline = Date.now() + displayWaitMilliseconds
  while (!existsSync(socket)) {
    if (Date.now() > deadline) throw new Error('The virtual display did not start')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const recentBlocks = new Map()
const proxy = await createPolicyProxy({
  settings: () => current,
  onBlocked: ({ host, reason }) => recentBlocks.set(host, { reason, at: Date.now() }),
})
const blockOf = (host) => {
  const block = recentBlocks.get(host)
  return block && Date.now() - block.at < blockMemoryMilliseconds ? blockReasons[block.reason] : undefined
}
const isHostMachineBlocked =
  current.blockInternalNetworks && !current.allowedInternalAddresses.includes(hostMachineName)

mkdirSync(filesDirectory, { recursive: true })
setInterval(() => void removeFilesOlderThan(filesDirectory, fileLifetimeMilliseconds), fileSweepMilliseconds)
await startDisplay().catch(fail)
const context = await chromium
  .launchPersistentContext(profileDirectory, {
    headless: false,
    viewport: null,
    acceptDownloads: true,
    downloadsPath: filesDirectory,
    ignoreDefaultArgs: ['--enable-automation'],
    env: { ...process.env, DISPLAY: display },
    args: [
      `--proxy-server=http://127.0.0.1:${proxy.port}`,
      '--proxy-bypass-list=<-loopback>',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--window-position=0,0',
      `--window-size=${initialWindow.width},${initialWindow.height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--password-store=basic',
      '--disable-dev-shm-usage',
      ...(isHostMachineBlocked ? [`--host-resolver-rules=MAP ${hostMachineName} ~NOTFOUND`] : []),
    ],
  })
  .catch(fail)
context.on('close', () => fail(new Error('The browser closed')))

const session = createBrowserSession({ context, send, settings: () => current, blockOf, filesDirectory })
reset = session.reset
await session.start().catch(fail)
receive = (message) => void session.receive(message)
for (const message of pending.splice(0)) receive(message)
isReady = true
send({ type: 'ready' })
