import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Docker, DockerError } from './docker.ts'
import { freeMemoryBytes, systemOf } from './system.ts'

const gibibyte = 1024 ** 3
const directory = mkdtempSync(join(tmpdir(), 'spyria-host-system-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const dockerWith = (containerHostnames: Record<string, string>) =>
  (async (_method: string, path: string) => {
    if (path === '/info') return { NCPU: 4, MemTotal: 16 * gibibyte, ServerVersion: '29' }
    const name = decodeURIComponent(path.match(/^\/containers\/(.+)\/json$/)?.[1] ?? '')
    const containerHostname = containerHostnames[name]
    if (containerHostname === undefined) throw new DockerError(404, `No such container: ${name}`)
    return { Config: { Hostname: containerHostname } }
  }) as Docker
const machineDocker = dockerWith({})

const machineRoot = (name: string, cgroupFiles: Record<string, Record<string, string>> = {}) => {
  const root = join(directory, name)
  mkdirSync(join(root, 'proc'), { recursive: true })
  writeFileSync(join(root, 'proc/meminfo'), `MemTotal: 16777216 kB\nMemAvailable: ${12 * 1024 * 1024} kB\n`)
  for (const [cgroupPath, files] of Object.entries(cgroupFiles)) {
    mkdirSync(join(root, 'sys/fs/cgroup', cgroupPath), { recursive: true })
    for (const [file, content] of Object.entries(files))
      writeFileSync(join(root, 'sys/fs/cgroup', cgroupPath, file), content)
  }
  return root
}
const memoryOf = async (root: string, docker = machineDocker) => {
  const source = { docker, ownContainer: 'spyria-host', root }
  return { totalBytes: (await systemOf(source)).memoryBytes, freeBytes: await freeMemoryBytes(source) }
}

const limitedMachine = machineRoot('limited', {
  '/': {
    'memory.max': `${4 * gibibyte}\n`,
    'memory.current': `${3 * gibibyte}\n`,
    'memory.stat': `anon 1024\ninactive_file ${gibibyte}\nactive_file 2048\n`,
  },
})

test("reports the machine's cgroup limit when the host and its Docker run under it, net of the reclaimable page cache", async () => {
  expect(await memoryOf(limitedMachine)).toEqual({ totalBytes: 4 * gibibyte, freeBytes: 2 * gibibyte })
})

test.each([
  ['its installed name', { 'spyria-host': hostname() }],
  ['its hostname', { [hostname()]: hostname() }],
])(
  'ignores the limit when the host is itself a container of its Docker, found by %s, since the runtimes are its siblings',
  async (_, containerHostnames) => {
    expect(await memoryOf(limitedMachine, dockerWith(containerHostnames))).toEqual({
      totalBytes: 16 * gibibyte,
      freeBytes: 12 * gibibyte,
    })
  },
)

test('applies the limit when a container of that name belongs to another machine', async () => {
  expect(await memoryOf(limitedMachine, dockerWith({ 'spyria-host': 'another-machine' }))).toEqual({
    totalBytes: 4 * gibibyte,
    freeBytes: 2 * gibibyte,
  })
})

test('keeps the machine memory when the cgroup limit is above it', async () => {
  const root = machineRoot('generous', { '/': { 'memory.max': `${64 * gibibyte}\n`, 'memory.current': '0\n' } })
  expect(await memoryOf(root)).toEqual({ totalBytes: 16 * gibibyte, freeBytes: 12 * gibibyte })
})

test.each([
  ['memory.max is max', machineRoot('unlimited', { '/': { 'memory.max': 'max\n' } })],
  ['there is no memory.max', machineRoot('no-controller')],
  [
    'only a cgroup below the root, which does not hold Docker, is limited',
    machineRoot('limited-scope', { '/system.slice/spyria-host.scope': { 'memory.max': `${gibibyte}\n` } }),
  ],
])('reports the machine memory when %s', async (_, root) => {
  expect(await memoryOf(root)).toEqual({ totalBytes: 16 * gibibyte, freeBytes: 12 * gibibyte })
})
