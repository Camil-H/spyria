import { readdirSync, readFileSync } from 'node:fs'

const distDirectory = new URL('../apps/web/dist/', import.meta.url).pathname
const mainChunkLimitBytes = 720_000
const serverOnlySqlAllowedCounts: Record<string, number> = {
  'into events': 0,
  'into sessions': 0,
  'skip locked': 0,
  'for update': 1,
  'into jobs': 1,
  'into llm_credentials': 1,
  placeholder_secrets: 2,
}

const failures: string[] = []
const mainChunkPath = readFileSync(`${distDirectory}index.html`, 'utf8').match(/<script[^>]+src="\/([^"]+\.js)"/)?.[1]
if (!mainChunkPath) throw new Error('No main chunk in apps/web/dist/index.html')
const mainChunkBytes = readFileSync(`${distDirectory}${mainChunkPath}`).byteLength
if (mainChunkBytes > mainChunkLimitBytes)
  failures.push(`${mainChunkPath} is ${mainChunkBytes} bytes, over the ${mainChunkLimitBytes} byte limit`)

const clientCode = readdirSync(`${distDirectory}assets`)
  .map((file) => readFileSync(`${distDirectory}assets/${file}`, 'utf8'))
  .join('\n')
  .toLowerCase()
for (const [statement, allowedCount] of Object.entries(serverOnlySqlAllowedCounts)) {
  const count = clientCode.split(statement).length - 1
  if (count > allowedCount)
    failures.push(`client assets contain "${statement}" ${count} times, ${allowedCount} allowed`)
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(`Bundle gates passed: main chunk ${mainChunkBytes} bytes, no new server-only SQL`)
