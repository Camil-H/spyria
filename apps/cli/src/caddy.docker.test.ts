import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const hasDocker =
  Bun.which('docker') !== null &&
  Bun.spawnSync(['docker', 'info'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
if (!hasDocker) console.warn('Skipping the Caddy Docker test: Docker is unavailable')

const pebbleImage =
  'ghcr.io/letsencrypt/pebble:2.10.0@sha256:68cf1ec8a8db96f64244d5f559c448bc8e54f2934e0dd53a414eabffda7a6f22'
const nodeImage = 'node:24-bookworm-slim'
const deployFolder = join(import.meta.dir, '../../../deploy')
const caddyImage = readFileSync(join(deployFolder, 'compose.prod.yml'), 'utf8').match(/image: (caddy:\S+)/)?.[1] ?? ''
const hostname = 'spyria.test'
const prefix = `spyria-test-caddy-${crypto.randomUUID().slice(0, 8)}`
const network = `${prefix}-network`
const pebble = `${prefix}-pebble`
const server = `${prefix}-server`
const caddy = `${prefix}-caddy`
const client = `${prefix}-client`
const containers = [pebble, server, caddy, client]
const folder = mkdtempSync(join(tmpdir(), `${prefix}-`))

const docker = (...dockerArguments: string[]) => {
  const result = Bun.spawnSync(['docker', ...dockerArguments], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0)
    throw new Error(`docker ${dockerArguments.join(' ')} failed: ${result.stderr.toString().trim()}`)
  return result.stdout.toString()
}

afterAll(() => {
  if (!hasDocker) return
  Bun.spawnSync(['docker', 'rm', '-f', ...containers], { stdout: 'ignore', stderr: 'ignore' })
  Bun.spawnSync(['docker', 'network', 'rm', network], { stdout: 'ignore', stderr: 'ignore' })
  rmSync(folder, { recursive: true, force: true })
})

const fakeServer = `
const http = require('node:http')
const crypto = require('node:crypto')
const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ path: request.url, host: request.headers.host, forwardedFor: request.headers['x-forwarded-for'] ?? null }))
})
server.on('upgrade', (request, socket) => {
  const accept = crypto.createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.end('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\nX-Upgraded-Path: ' + request.url + '\\r\\n\\r\\n')
})
server.listen(3000)
`

const visitor = `
const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs')
const crypto = require('node:crypto')
const pebbleAuthority = fs.readFileSync('/certs/pebble.minica.pem')
const read = (module, url, options) => new Promise((resolve, reject) =>
  module.get(url, options, (response) => {
    let body = ''
    response.on('data', (chunk) => (body += chunk))
    response.on('end', () => resolve({ status: response.statusCode, location: response.headers.location, body }))
  }).on('error', reject))
const upgrade = (url, ca) => new Promise((resolve, reject) => {
  const request = https.request(url, { ca, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') } })
  request.on('upgrade', (response, socket) => { socket.destroy(); resolve({ status: response.statusCode, path: response.headers['x-upgraded-path'] }) })
  request.on('response', (response) => resolve({ status: response.statusCode }))
  request.on('error', reject)
  request.end()
})
const main = async () => {
  const issuingRoot = (await read(https, 'https://pebble:15000/roots/0', { ca: pebbleAuthority })).body
  let health
  for (let attempt = 0; attempt < 90 && !health; attempt++)
    health = await read(https, 'https://${hostname}/health', { ca: issuingRoot }).catch(() => new Promise((resolve) => setTimeout(resolve, 1000)))
  const page = await read(https, 'https://${hostname}/chats/1?tab=files', { ca: issuingRoot })
  const zero = await read(https, 'https://${hostname}/zero/keepalive', { ca: issuingRoot })
  const zeroSocket = await upgrade('https://${hostname}/zero/sync/v49/connect?clientID=a', issuingRoot)
  const plainHttp = await read(http, 'http://${hostname}/health', {})
  console.log(JSON.stringify({ health, page, zero, zeroSocket, plainHttp }))
}
main().catch((error) => { console.error(error); process.exit(1) })
`

const pebbleConfig = {
  pebble: {
    listenAddress: '0.0.0.0:14000',
    managementListenAddress: '0.0.0.0:15000',
    certificate: 'test/certs/localhost/cert.pem',
    privateKey: 'test/certs/localhost/key.pem',
    httpPort: 80,
    tlsPort: 443,
    ocspResponderURL: '',
    externalAccountBindingRequired: false,
  },
}

const waitForLog = async (container: string, line: string) => {
  for (const deadline = Date.now() + 30_000; Date.now() < deadline; await Bun.sleep(250)) {
    const logs = Bun.spawnSync(['docker', 'logs', container], { stdout: 'pipe', stderr: 'pipe' })
    if (`${logs.stdout}${logs.stderr}`.includes(line)) return
  }
  throw new Error(`${container} did not log ${line}`)
}

test.skipIf(!hasDocker)(
  'the shipped Caddyfile gets a certificate from the ACME CA of SPYRIA_ACME_CA, serves every path, /zero/ and its WebSocket upgrade included, from the server over HTTPS, and redirects plain HTTP',
  async () => {
    expect(caddyImage).toMatch(/^caddy:[\d.]+@sha256:[0-9a-f]{64}$/)
    writeFileSync(join(folder, 'pebble-config.json'), JSON.stringify(pebbleConfig))
    writeFileSync(join(folder, 'server.js'), fakeServer)
    writeFileSync(join(folder, 'visitor.js'), visitor)
    docker('network', 'create', network)
    docker(
      'create',
      '--name',
      pebble,
      '--network',
      network,
      '--network-alias',
      'pebble',
      ...['-e', 'PEBBLE_VA_NOSLEEP=1'],
      ...['-e', 'PEBBLE_WFE_NONCEREJECT=0'],
      ...['-v', `${folder}/pebble-config.json:/config.json:ro`],
      pebbleImage,
      '-config',
      '/config.json',
    )
    docker('cp', `${pebble}:/test/certs/pebble.minica.pem`, join(folder, 'pebble.minica.pem'))
    docker('start', pebble)
    await waitForLog(pebble, 'Listening on: 0.0.0.0:14000')
    docker(
      'run',
      '-d',
      '--name',
      server,
      '--network',
      network,
      '--network-alias',
      'server',
      ...['-v', `${folder}/server.js:/server.js:ro`],
      nodeImage,
      'node',
      '/server.js',
    )
    docker(
      ...['run', '-d', '--name', caddy, '--network', network, '--network-alias', hostname],
      ...[
        '-e',
        `SPYRIA_APP_ORIGIN=https://${hostname}`,
        '-e',
        'SPYRIA_ACME_CA=https://pebble:14000/dir',
        '-e',
        'SPYRIA_ACME_EMAIL=',
      ],
      ...[
        '-e',
        'SSL_CERT_FILE=/certs/pebble.minica.pem',
        '-v',
        `${folder}/pebble.minica.pem:/certs/pebble.minica.pem:ro`,
      ],
      ...['-v', `${deployFolder}/Caddyfile:/etc/caddy/Caddyfile:ro`],
      caddyImage,
    )
    const visit = Bun.spawnSync(
      [
        ...['docker', 'run', '--name', client, '--network', network],
        ...[
          '-v',
          `${folder}/visitor.js:/visitor.js:ro`,
          '-v',
          `${folder}/pebble.minica.pem:/certs/pebble.minica.pem:ro`,
        ],
        ...[nodeImage, 'node', '/visitor.js'],
      ],
      { stdout: 'pipe', stderr: 'pipe', timeout: 150_000 },
    )
    if (visit.exitCode !== 0)
      throw new Error(`The visit failed: ${visit.stderr.toString()}\n${docker('logs', '--tail', '30', caddy)}`)
    const { health, page, zero, zeroSocket, plainHttp } = JSON.parse(visit.stdout.toString())
    const answerOf = (visited: { body: string }) => JSON.parse(visited.body)
    expect(health.status).toBe(200)
    expect(answerOf(health)).toMatchObject({ path: '/health', host: hostname })
    expect(answerOf(health).forwardedFor).toMatch(/^[\d.]+$/)
    expect(answerOf(page)).toMatchObject({ path: '/chats/1?tab=files' })
    expect(answerOf(zero)).toMatchObject({ path: '/zero/keepalive' })
    expect(zeroSocket).toEqual({ status: 101, path: '/zero/sync/v49/connect?clientID=a' })
    expect(plainHttp.status).toBe(308)
    expect(plainHttp.location).toBe(`https://${hostname}/health`)
  },
  180_000,
)
