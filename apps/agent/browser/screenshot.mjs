import { spawnSync } from 'node:child_process'

process.env.PLAYWRIGHT_BROWSERS_PATH ??= new URL('./chromium', import.meta.url).pathname
const { chromium } = await import('playwright-core')

const playwrightCli = new URL('./node_modules/playwright-core/cli.js', import.meta.url).pathname
const loadTimeoutMilliseconds = 20_000
const settleTimeoutMilliseconds = 3_000
const maximumPageHeight = 10_000
const viewports = {
  desktop: { viewport: { width: 1280, height: 800 } },
  mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
}

const install = () => {
  const installed = spawnSync(
    process.execPath,
    [playwrightCli, 'install', '--no-progress', 'chromium-headless-shell'],
    {
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  )
  process.exitCode = installed.status ?? 1
}

const capture = async ({ url, output, viewport, fullPage, theme }) => {
  const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] })
  try {
    const page = await browser.newPage({ ...viewports[viewport], colorScheme: theme })
    await page.goto(url, { waitUntil: 'load', timeout: loadTimeoutMilliseconds })
    await page.waitForLoadState('networkidle', { timeout: settleTimeoutMilliseconds }).catch(() => {})
    const { scrollWidth, scrollHeight } = await page.evaluate(() => {
      const { scrollWidth, scrollHeight } = document.documentElement
      return { scrollWidth, scrollHeight }
    })
    const isCut = fullPage && scrollHeight > maximumPageHeight
    await page.screenshot({
      path: output,
      fullPage,
      ...(isCut && { clip: { x: 0, y: 0, width: scrollWidth, height: maximumPageHeight } }),
    })
  } finally {
    await browser.close()
  }
}

const [command, request] = process.argv.slice(2)
if (command === 'install') install()
else
  await capture(JSON.parse(request)).catch((error) => {
    console.error(String(error?.message ?? error).split('\n')[0])
    process.exitCode = 1
  })
