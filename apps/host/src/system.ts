import { readFile } from 'node:fs/promises'
import { freemem } from 'node:os'
import type { Docker } from './docker.ts'

export const systemOf = async (docker: Docker) => {
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
  return {
    cpus: info.NCPU,
    memoryBytes: info.MemTotal,
    dockerVersion: info.ServerVersion,
    rootless: (info.SecurityOptions ?? []).some((option) => option.includes('rootless')),
    cgroupDriver,
    limitsEnforced: cgroupDriver !== 'none' && info.MemoryLimit !== false && info.PidsLimit !== false,
  }
}

export const freeMemoryBytes = async () => {
  const meminfo = await readFile('/proc/meminfo', 'utf8').catch(() => '')
  const availableKilobytes = meminfo.match(/MemAvailable:\s+(\d+) kB/)?.[1]
  return availableKilobytes ? Number(availableKilobytes) * 1024 : freemem()
}
