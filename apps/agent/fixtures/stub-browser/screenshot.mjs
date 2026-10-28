import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
const log = (file, line) =>
  process.env.STUB_BROWSER_LOG && appendFileSync(join(process.env.STUB_BROWSER_LOG, file), `${line}\n`)
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const [, request] = process.argv.slice(2)
const { output, ...capture } = JSON.parse(request)
if (capture.url.includes('refused')) {
  console.error(`page.goto: net::ERR_CONNECTION_REFUSED at ${capture.url}`)
  process.exit(1)
}
if (capture.url.includes('slow')) await pause(5000)
log('captures', JSON.stringify(capture))
writeFileSync(output, capture.url.includes('huge') ? Buffer.alloc(21 * 1024 * 1024) : onePixelPng)
