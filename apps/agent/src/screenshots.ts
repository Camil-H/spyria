import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

type Environment = Record<string, string>

const screenshotsDirectory = '.spyria/screenshots'
const namePattern = /^[\w-]{1,64}$/
const webAddress = /^https?:\/\//i
const viewports = ['desktop', 'mobile']
const themes = ['light', 'dark']
const maximumScreenshotBytes = 20 * 1024 * 1024
const failureCharacters = 300

const run = async (command: string[], env: Environment, timeoutMilliseconds: number) => {
  const child = Bun.spawn(command, {
    env,
    stdout: 'ignore',
    stderr: 'pipe',
    timeout: timeoutMilliseconds,
    killSignal: 'SIGTERM',
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

const keepOutOfGit = (directory: string) =>
  writeFile(join(directory, '.gitignore'), '*\n', { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })

export const createScreenshotTaker = (browserDirectory: string, { captureTimeoutMilliseconds = 30_000 } = {}) => {
  const script = join(browserDirectory, 'screenshot.mjs')
  return async (root: string, body: unknown, env: Environment) => {
    const request = screenshotRequestOf(body)
    if (!request) return { failure: 'The screenshot request is not valid' }
    const path = `${screenshotsDirectory}/${request.name}.png`
    await mkdir(join(root, screenshotsDirectory), { recursive: true })
    await keepOutOfGit(join(root, screenshotsDirectory))
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
