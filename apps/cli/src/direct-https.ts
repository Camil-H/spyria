import { resolve4, resolve6 } from 'node:dns/promises'
import { readFileSync } from 'node:fs'
import { shellEnvironmentOf } from './compose.ts'

export type DirectHttpsProbes = {
  addressesOf: (hostname: string) => Promise<string[]>
  isDockerRootless: () => boolean
  unprivilegedPortStart: () => number | undefined
  isPortInUse: (port: number) => Promise<boolean>
}

const publicPorts = [80, 443]
const lowestPublicPort = 80
const defaultUnprivilegedPortStart = 1024
const unprivilegedPortStartFile = '/proc/sys/net/ipv4/ip_unprivileged_port_start'

const addressesInDnsOf = async (hostname: string) =>
  (await Promise.allSettled([resolve4(hostname), resolve6(hostname)])).flatMap((answer) =>
    answer.status === 'fulfilled' ? answer.value : [],
  )

const isDockerRootlessHere = () => {
  const docker = Bun.which('docker', { PATH: process.env.PATH ?? '' })
  if (docker === null) return false
  const info = Bun.spawnSync([docker, 'info', '--format', '{{.SecurityOptions}}'], {
    env: shellEnvironmentOf(process.env),
    stdout: 'pipe',
    stderr: 'ignore',
  })
  return info.stdout.toString().includes('rootless')
}

const unprivilegedPortStartHere = () => {
  try {
    return Number(readFileSync(unprivilegedPortStartFile, 'utf8').trim())
  } catch {
    return undefined
  }
}

const isPortInUseHere = (port: number) =>
  Bun.connect({ hostname: '127.0.0.1', port, socket: { data: () => undefined } }).then(
    (socket) => {
      socket.end()
      return true
    },
    () => false,
  )

export const directHttpsProbesOfThisMachine: DirectHttpsProbes = {
  addressesOf: addressesInDnsOf,
  isDockerRootless: isDockerRootlessHere,
  unprivilegedPortStart: unprivilegedPortStartHere,
  isPortInUse: isPortInUseHere,
}

export const assertServesDirectly = async (
  hostname: string,
  { holdsPublicPortsAlready }: { holdsPublicPortsAlready: boolean },
  probes: DirectHttpsProbes,
) => {
  if ((await probes.addressesOf(hostname)).length === 0)
    throw new Error(`Point ${hostname} at this machine's public address (an A or AAAA record), then run this again.`)
  if (probes.isDockerRootless() && (probes.unprivilegedPortStart() ?? defaultUnprivilegedPortStart) > lowestPublicPort)
    throw new Error(
      `Rootless Docker cannot publish ports 80 and 443 on this machine: run sudo sysctl net.ipv4.ip_unprivileged_port_start=${lowestPublicPort}, and to keep it after a restart, echo net.ipv4.ip_unprivileged_port_start=${lowestPublicPort} | sudo tee /etc/sysctl.d/99-spyria.conf, then run this again.`,
    )
  if (holdsPublicPortsAlready) return
  for (const port of publicPorts)
    if (await probes.isPortInUse(port))
      throw new Error(
        `Port ${port} is in use on this machine: stop what listens on it, or choose --https tunnel, then run this again.`,
      )
}
