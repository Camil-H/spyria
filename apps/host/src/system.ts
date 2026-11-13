import { readFile } from 'node:fs/promises'
import { freemem, hostname } from 'node:os'
import { join } from 'node:path'
import { type Docker, DockerError } from './docker.ts'

export type MemorySource = { docker: Docker; ownContainer: string; root?: string }

const textOf = (path: string) => readFile(path, 'utf8').catch(() => '')

const hostnameOfContainer = (docker: Docker, name: string) =>
  docker<{ Config?: { Hostname?: string } }>('GET', `/containers/${encodeURIComponent(name)}/json`).then(
    (container) => container.Config?.Hostname,
    (error) => {
      if (error instanceof DockerError && error.status === 404) return undefined
      throw error
    },
  )

const isContainerOfItsDockerBySource = new WeakMap<MemorySource, Promise<boolean>>()
const isContainerOfItsDocker = (source: MemorySource) => {
  const known = isContainerOfItsDockerBySource.get(source)
  if (known) return known
  const asked = Promise.all(
    [source.ownContainer, hostname()].map((name) => hostnameOfContainer(source.docker, name)),
  ).then((containerHostnames) => containerHostnames.includes(hostname()))
  isContainerOfItsDockerBySource.set(source, asked)
  asked.catch(() => isContainerOfItsDockerBySource.delete(source))
  return asked
}

const machineCgroupMemoryOf = async (source: MemorySource) => {
  const directory = join(source.root ?? '/', 'sys/fs/cgroup')
  const limitBytes = Number.parseInt(await textOf(join(directory, 'memory.max')), 10)
  if (!Number.isSafeInteger(limitBytes) || (await isContainerOfItsDocker(source))) return undefined
  const usedBytes = Number.parseInt(await textOf(join(directory, 'memory.current')), 10) || 0
  const inactiveFileBytes = Number(
    (await textOf(join(directory, 'memory.stat'))).match(/^inactive_file (\d+)$/m)?.[1] ?? 0,
  )
  return { limitBytes, freeBytes: Math.max(0, limitBytes - Math.max(0, usedBytes - inactiveFileBytes)) }
}

export const systemOf = async (source: MemorySource) => {
  const info = await source.docker<{
    NCPU: number
    MemTotal: number
    ServerVersion: string
    SecurityOptions?: string[]
    CgroupDriver?: string
    MemoryLimit?: boolean
    PidsLimit?: boolean
  }>('GET', '/info')
  const cgroupDriver = info.CgroupDriver ?? 'none'
  const cgroupMemory = await machineCgroupMemoryOf(source)
  return {
    cpus: info.NCPU,
    memoryBytes: Math.min(info.MemTotal, cgroupMemory?.limitBytes ?? info.MemTotal),
    dockerVersion: info.ServerVersion,
    rootless: (info.SecurityOptions ?? []).some((option) => option.includes('rootless')),
    cgroupDriver,
    limitsEnforced: cgroupDriver !== 'none' && info.MemoryLimit !== false && info.PidsLimit !== false,
  }
}

export const freeMemoryBytes = async (source: MemorySource) => {
  const meminfo = await textOf(join(source.root ?? '/', 'proc/meminfo'))
  const availableKilobytes = meminfo.match(/MemAvailable:\s+(\d+) kB/)?.[1]
  const machineFreeBytes = availableKilobytes ? Number(availableKilobytes) * 1024 : freemem()
  const cgroupMemory = await machineCgroupMemoryOf(source)
  return Math.min(machineFreeBytes, cgroupMemory?.freeBytes ?? machineFreeBytes)
}
