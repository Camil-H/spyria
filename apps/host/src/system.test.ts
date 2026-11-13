import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Docker } from './docker.ts'
import { freeMemoryBytes, systemOf } from './system.ts'

const gibibyte = 1024 ** 3
const directory = mkdtempSync(join(tmpdir(), 'spyria-host-system-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const docker = (async () => ({ NCPU: 4, MemTotal: 16 * gibibyte, ServerVersion: '29' })) as Docker

const machineRoot = (
  name: string,
  { cgroup = '0::/\n', files = {} }: { cgroup?: string; files?: Record<string, string> } = {},
) => {
  const root = join(directory, name)
  const cgroupPath = cgroup.match(/^0::(\/.*)$/m)?.[1] ?? '/'
  mkdirSync(join(root, 'proc/self'), { recursive: true })
  mkdirSync(join(root, 'sys/fs/cgroup', cgroupPath), { recursive: true })
  writeFileSync(join(root, 'proc/self/cgroup'), cgroup)
  writeFileSync(join(root, 'proc/meminfo'), `MemTotal: 16777216 kB\nMemAvailable: ${12 * 1024 * 1024} kB\n`)
  for (const [file, content] of Object.entries(files))
    writeFileSync(join(root, 'sys/fs/cgroup', cgroupPath, file), content)
  return root
}

test('reports the memory of its own cgroup when memory.max is set, net of the reclaimable page cache', async () => {
  const root = machineRoot('limited', {
    files: {
      'memory.max': `${4 * gibibyte}\n`,
      'memory.current': `${3 * gibibyte}\n`,
      'memory.stat': `anon 1024\ninactive_file ${gibibyte}\nactive_file 2048\n`,
    },
  })
  expect((await systemOf(docker, root)).memoryBytes).toBe(4 * gibibyte)
  expect(await freeMemoryBytes(root)).toBe(2 * gibibyte)
})

test('reads memory.max in the cgroup named by /proc/self/cgroup', async () => {
  const root = machineRoot('nested', {
    cgroup: '0::/system.slice/spyria-host.scope\n',
    files: { 'memory.max': `${2 * gibibyte}\n`, 'memory.current': '0\n' },
  })
  expect((await systemOf(docker, root)).memoryBytes).toBe(2 * gibibyte)
  expect(await freeMemoryBytes(root)).toBe(2 * gibibyte)
})

test('keeps the machine memory when the cgroup limit is above it', async () => {
  const root = machineRoot('generous', { files: { 'memory.max': `${64 * gibibyte}\n`, 'memory.current': '0\n' } })
  expect((await systemOf(docker, root)).memoryBytes).toBe(16 * gibibyte)
  expect(await freeMemoryBytes(root)).toBe(12 * gibibyte)
})

test.each([
  ['memory.max is max', machineRoot('unlimited', { files: { 'memory.max': 'max\n' } })],
  ['there is no memory.max', machineRoot('no-controller')],
  ['the machine has no unified cgroup', machineRoot('cgroup-v1', { cgroup: '4:memory:/docker/abc\n' })],
])('reports the machine memory when %s', async (_, root) => {
  expect((await systemOf(docker, root)).memoryBytes).toBe(16 * gibibyte)
  expect(await freeMemoryBytes(root)).toBe(12 * gibibyte)
})
