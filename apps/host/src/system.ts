import { readFile } from 'node:fs/promises'
import { freemem } from 'node:os'
import { join } from 'node:path'
import type { Docker } from './docker.ts'

const textOf = (path: string) => readFile(path, 'utf8').catch(() => '')

const cgroupDirectoryOf = async (root: string) => {
  const unifiedPath = (await textOf(join(root, 'proc/self/cgroup'))).match(/^0::(\/.*)$/m)?.[1]
  return unifiedPath === undefined ? undefined : join(root, 'sys/fs/cgroup', unifiedPath)
}

const cgroupMemoryOf = async (root: string) => {
  const directory = await cgroupDirectoryOf(root)
  if (directory === undefined) return undefined
  const limitBytes = Number.parseInt(await textOf(join(directory, 'memory.max')), 10)
  if (!Number.isSafeInteger(limitBytes)) return undefined
  const usedBytes = Number.parseInt(await textOf(join(directory, 'memory.current')), 10) || 0
  const inactiveFileBytes = Number(
    (await textOf(join(directory, 'memory.stat'))).match(/^inactive_file (\d+)$/m)?.[1] ?? 0,
  )
  return { limitBytes, freeBytes: Math.max(0, limitBytes - Math.max(0, usedBytes - inactiveFileBytes)) }
}

export const systemOf = async (docker: Docker, root = '/') => {
  const info = await docker<{
    NCPU: number
    MemTotal: number
    ServerVersion: string
    SecurityOptions?: string[]
    CgroupDriver?: string
    MemoryLimit?: boolean
    PidsLimit?: boolean
  }>('GET', '/info')
  const cgroupDriver = info.CgroupDriver ?? 'none'
  const cgroupMemory = await cgroupMemoryOf(root)
  return {
    cpus: info.NCPU,
    memoryBytes: Math.min(info.MemTotal, cgroupMemory?.limitBytes ?? info.MemTotal),
    dockerVersion: info.ServerVersion,
    rootless: (info.SecurityOptions ?? []).some((option) => option.includes('rootless')),
    cgroupDriver,
    limitsEnforced: cgroupDriver !== 'none' && info.MemoryLimit !== false && info.PidsLimit !== false,
  }
}

export const freeMemoryBytes = async (root = '/') => {
  const availableKilobytes = (await textOf(join(root, 'proc/meminfo'))).match(/MemAvailable:\s+(\d+) kB/)?.[1]
  const machineFreeBytes = availableKilobytes ? Number(availableKilobytes) * 1024 : freemem()
  const cgroupMemory = await cgroupMemoryOf(root)
  return Math.min(machineFreeBytes, cgroupMemory?.freeBytes ?? machineFreeBytes)
}
