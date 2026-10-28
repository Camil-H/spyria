import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

type Environment = Record<string, string>
type Run = { isDone: boolean; errorOutput: string }

const screenshotsDirectory = '.spyria/screenshots'
const namePattern = /^[\w-]{1,64}$/
const webAddress = /^https?:\/\//i
const viewports = ['desktop', 'mobile']
const themes = ['light', 'dark']
const maximumScreenshotBytes = 20 * 1024 * 1024
const failureCharacters = 300

const run = async (command: string[], env: Environment, timeoutMilliseconds?: number): Promise<Run> => {
  const child = Bun.spawn(command, {
    env,
    stdout: 'ignore',
    stderr: 'pipe',
    ...(timeoutMilliseconds && { timeout: timeoutMilliseconds, killSignal: 'SIGTERM' }),
  })
  const errorOutput = await new Response(child.stderr).text()
  return { isDone: (await child.exited) === 0, errorOutput: errorOutput.trim().slice(0, failureCharacters) }
}

const screenshotRequestOf = (body: unknown) => {
  const { url, name, viewport, fullPage, theme } = (body ?? {}) as Record<string, unknown>
  const isValid =
    typeof url === 'string' &&
    webAddress.test(url) &&
    URL.canParse(url) &&
    typeof name === 'string' &&
    namePattern.test(name) &&
    viewports.includes(String(viewport)) &&
    typeof fullPage === 'boolean' &&
    themes.includes(String(theme))
  return isValid ? { url, name, viewport, fullPage, theme } : undefined
}

export const createScreenshotTaker = (
  browserDirectory: string,
  { captureTimeoutMilliseconds = 30_000, installWaitMilliseconds = 75_000 } = {},
) => {
  const script = join(browserDirectory, 'screenshot.mjs')
  let installing: Promise<Run> | undefined
  const installChromium = (env: Environment) => {
    installing ??= run(['node', script, 'install'], env).then((installed) => {
      if (!installed.isDone) installing = undefined
      return installed
    })
    return installing
  }
  return async (root: string, body: unknown, env: Environment) => {
    const request = screenshotRequestOf(body)
    if (!request) return { failure: 'The screenshot request is not valid' }
    const installed = await Promise.race([installChromium(env), Bun.sleep(installWaitMilliseconds)])
    if (!installed)
      return {
        failure: 'Chromium is still being installed for screenshots, once per runtime: try again in a minute',
      }
    if (!installed.isDone) return { failure: `Installing Chromium for screenshots failed: ${installed.errorOutput}` }
    const path = `${screenshotsDirectory}/${request.name}.png`
    await mkdir(join(root, screenshotsDirectory), { recursive: true })
    await writeFile(join(root, '.spyria', '.gitignore'), '*\n')
    const { name, ...capture } = request
    const captured = await run(
      ['node', script, 'capture', JSON.stringify({ ...capture, output: join(root, path) })],
      env,
      captureTimeoutMilliseconds,
    )
    if (!captured.isDone)
      return {
        failure: `The screenshot of ${request.url} failed: ${captured.errorOutput || `it took longer than ${captureTimeoutMilliseconds / 1000} seconds`}`,
      }
    if ((await stat(join(root, path))).size <= maximumScreenshotBytes) return { path }
    await rm(join(root, path), { force: true })
    return { failure: 'The screenshot is larger than 20 MB: take it without the full page' }
  }
}
