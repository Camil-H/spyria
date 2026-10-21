import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

export const distrustedRootPemPrefixes = {
  'emSign ECC Root CA - G3': 'MIICTjCCAdOgAwIBAgIKPPYHqWhwDtqLhDAKBggqhkjOPQQD',
  'AAA Certificate Services': 'MIIEMjCCAxqgAwIBAgIBATANBgkqhkiG9w0BAQUFADB7MQsw',
}
const systemStorePaths = ['/etc/ssl/certs', '/usr/share/ca-certificates']
const runtimePaths = ['/usr/local/bin']

const docker = (command: string[]) => {
  const result = Bun.spawnSync(['docker', ...command], { stdout: 'pipe', stderr: 'pipe' })
  return { isOk: result.exitCode === 0, output: result.stdout.toString().trim() }
}

const distrustedRootsInPath = async (container: string, path: string) => {
  const copy = Bun.spawn(['docker', 'cp', '-L', `${container}:${path}`, '-'], { stdout: 'pipe', stderr: 'ignore' })
  const found = new Set<string>()
  let carry = Buffer.alloc(0)
  for await (const chunk of copy.stdout) {
    const window = Buffer.concat([carry, chunk])
    for (const [root, prefix] of Object.entries(distrustedRootPemPrefixes)) if (window.includes(prefix)) found.add(root)
    carry = window.subarray(-64)
  }
  await copy.exited
  return [...found].map((root) => `${root} in ${path}`)
}

export const distrustedRootsIn = async (target: string) => {
  const isContainer = docker(['container', 'inspect', target]).isOk
  const container = isContainer ? target : `spyria-test-certs-${randomBytes(4).toString('hex')}`
  if (!isContainer && !docker(['create', '--name', container, target, '/check-trust']).isOk)
    throw new Error(`cannot create a container from ${target}`)
  try {
    const environment = Object.fromEntries(
      (JSON.parse(docker(['inspect', '--format', '{{json .Config.Env}}', container]).output) as string[]).map(
        (variable) => variable.split('=', 2),
      ),
    )
    const certificatePaths = [environment.SSL_CERT_FILE, ...(environment.SSL_CERT_DIR?.split(':') ?? [])].filter(
      Boolean,
    )
    const paths = [...runtimePaths, ...(certificatePaths.length > 0 ? certificatePaths : systemStorePaths)]
    return (await Promise.all(paths.map((path) => distrustedRootsInPath(container, path)))).flat()
  } finally {
    if (!isContainer) docker(['rm', '-f', container])
  }
}

export const checkTrust = async (targets: string[]) => {
  let isClean = true
  for (const target of targets) {
    const found = await distrustedRootsIn(target)
    isClean &&= found.length === 0
    console.log(`${found.length === 0 ? 'ok' : 'TRUSTED'} ${target}${found.map((entry) => `\n  ${entry}`).join('')}`)
  }
  return isClean
}

if (import.meta.main) {
  const targets = process.argv.slice(2)
  const hostImage = 'spyria-test-trust-host'
  const isDefault = targets.length === 0
  if (isDefault) {
    const agentImageFile = new URL('../apps/agent/image-id', import.meta.url).pathname
    const hostDirectory = new URL('../apps/host', import.meta.url).pathname
    if (!docker(['build', '-q', '-t', hostImage, hostDirectory]).isOk) throw new Error('the host image did not build')
    targets.push(readFileSync(agentImageFile, 'utf8').trim(), hostImage)
  }
  const isClean = await checkTrust(targets)
  if (isDefault) docker(['image', 'rm', hostImage])
  process.exit(isClean ? 0 : 1)
}
