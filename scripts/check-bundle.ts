import { readdirSync, readFileSync } from 'node:fs'

const distDirectory = new URL('../apps/web/dist/', import.meta.url).pathname
const mainChunkLimitBytes = 760_000
const serverOnlySql = [
  'into events',
  'into sessions',
  'skip locked',
  'for update',
  'into jobs',
  'into llm_credentials',
  'placeholder_secrets',
  'claim_code_hash',
  'token_hash',
]

const failures: string[] = []
const mainChunkPath = readFileSync(`${distDirectory}index.html`, 'utf8').match(/<script[^>]+src="\/([^"]+\.js)"/)?.[1]
if (!mainChunkPath) throw new Error('No main chunk in apps/web/dist/index.html')
const mainChunk = readFileSync(`${distDirectory}${mainChunkPath}`, 'utf8')
const mainChunkBytes = Buffer.byteLength(mainChunk)
if (mainChunkBytes > mainChunkLimitBytes)
  failures.push(`${mainChunkPath} is ${mainChunkBytes} bytes, over the ${mainChunkLimitBytes} byte limit`)
const reactVersions = new Set(Array.from(mainChunk.matchAll(/version[=:]`(19\.\d+\.\d+)`/g), (match) => match[1]))
if (reactVersions.size !== 1)
  failures.push(`${mainChunkPath} holds ${reactVersions.size} React versions: ${[...reactVersions].join(', ')}`)

const clientCode = readdirSync(`${distDirectory}assets`)
  .filter((file) => file.endsWith('.js') || file.endsWith('.css'))
  .map((file) => readFileSync(`${distDirectory}assets/${file}`, 'utf8'))
  .join('\n')
  .toLowerCase()
for (const statement of serverOnlySql)
  if (clientCode.includes(statement)) failures.push(`client assets contain server-only SQL "${statement}"`)

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(
  `Bundle gates passed: main chunk ${mainChunkBytes} bytes, React ${[...reactVersions].join('')}, no server-only SQL`,
)
