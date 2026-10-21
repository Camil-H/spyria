import { createHash } from 'node:crypto'
import { type Docker, DockerError, type Mount } from './docker.ts'
import pins from './harnesses.json'

export type HarnessId = keyof typeof pins
export const harnessIds = Object.keys(pins) as HarnessId[]
export const harnessNames: Record<HarnessId, string> = { 'claude-code': 'Claude Code', codex: 'Codex' }

const harnessesTarget = '/harnesses'
const systemPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const maximumFailureLength = 400
export const installTimeoutMilliseconds = 220_000
const terminalEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')

export const pinnedPackagesOf = (harness: HarnessId) =>
  Object.entries(pins[harness].packages).map(([name, version]) => `${name}@${version}`)
const pinsHashOf = (harness: HarnessId) =>
  createHash('sha256').update(pinnedPackagesOf(harness).join(' ')).digest('hex').slice(0, 12)
export const harnessFolderOf = (harness: HarnessId) => `${harnessesTarget}/${harness}/${pinsHashOf(harness)}`
const currentBinOf = (harness: HarnessId) => `${harnessesTarget}/${harness}/current/bin`

export const harnessEnvironment = [
  `PATH=${harnessIds.map(currentBinOf).join(':')}:${systemPath}`,
  ...harnessIds.flatMap((harness) =>
    Object.entries(pins[harness].executables).map(
      ([variable, executable]) => `${variable}=${currentBinOf(harness)}/${executable}`,
    ),
  ),
]

export const harnessesMountOf = (prefix: string, readOnly = true): Mount => ({
  Type: 'volume',
  Source: process.env.SPYRIA_HARNESSES_VOLUME ?? `${prefix}harnesses`,
  Target: harnessesTarget,
  ReadOnly: readOnly,
})

export const installScriptOf = (harness: HarnessId, registry = process.env.SPYRIA_HARNESS_REGISTRY) => {
  const hash = pinsHashOf(harness)
  return `set -e
mkdir -p ${harnessesTarget}/${harness}
cd ${harnessesTarget}/${harness}
if [ ! -e ${hash}/.installed ]; then
  rm -rf ${hash}.partial
  npm install -g --no-fund --no-audit --loglevel=error --color=false --no-progress --prefix ${hash}.partial${registry ? ` --registry ${registry}` : ''} ${pinnedPackagesOf(harness).join(' ')}
  rm -rf ${hash}
  mv ${hash}.partial ${hash}
  touch ${hash}/.installed
fi
ln -sfn ${hash} current.next
mv -T current.next current
find . -mindepth 1 -maxdepth 1 ! -name ${hash} ! -name current -exec rm -rf {} +`
}

export const installFailureOf = (output: string) => {
  const lines = output
    .replace(terminalEscape, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const npmErrors = lines
    .filter((line) => line.startsWith('npm error ') && !line.includes('A complete log of this run'))
    .map((line) => line.slice('npm error '.length))
    .filter((line) => !/^\d+$/.test(line))
  const reason = [...new Set(npmErrors.length > 0 ? npmErrors : lines)].slice(0, 3).join('\n')
  return (reason || 'npm install failed').slice(0, maximumFailureLength)
}

export const installContainerBodyOf = (prefix: string, image: string, harness: HarnessId) => ({
  Image: image,
  User: '10001:10001',
  Entrypoint: ['sh', '-c', installScriptOf(harness)],
  Tty: true,
  Labels: { 'spyria.managed': '1' },
  HostConfig: {
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges'],
    ReadonlyRootfs: true,
    NetworkMode: 'bridge',
    Tmpfs: { '/home/openhands': 'uid=10001,gid=10001,mode=0700', '/tmp': '' },
    Mounts: [harnessesMountOf(prefix, false)],
  },
})

const ignoringMissing = (error: unknown) => {
  if (!(error instanceof DockerError && error.status === 404)) throw error
}

export const isHarnessInstalled = (docker: Docker, container: string, harness: HarnessId) =>
  docker('HEAD', `/containers/${container}/archive?path=${harnessFolderOf(harness)}/.installed`).then(
    () => true,
    (error) => {
      ignoringMissing(error)
      return false
    },
  )

const runInstall = async (docker: Docker, prefix: string, image: string, harness: HarnessId) => {
  const name = `${prefix}harness-install-${harness}`
  await docker('DELETE', `/containers/${name}?force=true`).catch(ignoringMissing)
  await docker('POST', `/containers/create?name=${name}`, installContainerBodyOf(prefix, image, harness))
  try {
    await docker('POST', `/containers/${name}/start`)
    const { StatusCode } = await docker<{ StatusCode: number }>(
      'POST',
      `/containers/${name}/wait`,
      undefined,
      installTimeoutMilliseconds,
    )
    if (StatusCode !== 0)
      throw new Error(installFailureOf(await docker<string>('GET', `/containers/${name}/logs?stdout=1&stderr=1`)))
  } finally {
    await docker('DELETE', `/containers/${name}?force=true`).catch(() => {})
  }
}

const runningInstalls = new Map<HarnessId, Promise<void>>()

export const installHarness = (docker: Docker, prefix: string, image: string, harness: HarnessId) => {
  const install =
    runningInstalls.get(harness) ??
    runInstall(docker, prefix, image, harness).finally(() => runningInstalls.delete(harness))
  runningInstalls.set(harness, install)
  return install
}
