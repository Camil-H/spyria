import { readdirSync, readFileSync, realpathSync } from 'node:fs'

const rootDirectory = new URL('../', import.meta.url).pathname
const distDirectory = `${rootDirectory}apps/web/dist/`
const mainChunkLimitBytes = 250_000
const singletonPackages = ['react', 'react-dom', 'react-router', '@rocicorp/zero']
const serverOnlySql = [
  'into events',
  'into sessions',
  'skip locked',
  'for update',
  'into jobs',
  'into llm_credentials',
  'member_gateway_keys',
  'claim_code_hash',
  'token_hash',
  'agent_turn_failure',
  'agent_conversation_id',
  'api/governance',
]
const lazyChunkMarkers = ['Load image from', 'registerLanguage']

const failures: string[] = []
const mainChunkPath = readFileSync(`${distDirectory}index.html`, 'utf8').match(/<script[^>]+src="\/([^"]+\.js)"/)?.[1]
if (!mainChunkPath) throw new Error('No main chunk in apps/web/dist/index.html')
const mainChunk = readFileSync(`${distDirectory}${mainChunkPath}`, 'utf8')
const mainChunkBytes = Buffer.byteLength(mainChunk)
if (mainChunkBytes > mainChunkLimitBytes)
  failures.push(
    `${mainChunkPath} is ${mainChunkBytes} bytes, over the ${mainChunkLimitBytes} byte limit: move a route or a vendor library into a lazy chunk before raising the limit`,
  )
for (const marker of lazyChunkMarkers)
  if (mainChunk.includes(marker)) failures.push(`${mainChunkPath} contains "${marker}", which belongs in a lazy chunk`)
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
if (clientCode.includes('spyriateststack')) failures.push('client assets contain the e2e test hook spyriaTestStack')

const webWorkspaces = ['apps/web', ...readdirSync(`${rootDirectory}packages`).map((name) => `packages/${name}`)]
for (const packageName of singletonPackages) {
  const workspacesByInstall = Map.groupBy(
    webWorkspaces.filter((workspace) => {
      const manifest = JSON.parse(readFileSync(`${rootDirectory}${workspace}/package.json`, 'utf8'))
      return packageName in { ...manifest.dependencies, ...manifest.peerDependencies }
    }),
    (workspace) => realpathSync(Bun.resolveSync(packageName, `${rootDirectory}${workspace}/package.json`)),
  )
  if (workspacesByInstall.size > 1)
    failures.push(
      `${packageName} is installed ${workspacesByInstall.size} times (${[...workspacesByInstall.values()].map((workspaces) => workspaces.join(', ')).join(' / ')}): align its version and peer dependencies, then reinstall`,
    )
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(
  `Bundle gates passed: main chunk ${mainChunkBytes} bytes, React ${[...reactVersions].join('')}, ${singletonPackages.join(', ')} installed once, no server-only SQL, no test hook, Markdown and highlighting lazy`,
)
