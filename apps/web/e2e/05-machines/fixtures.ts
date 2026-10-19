import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page } from '@playwright/test'
import { machineTest as base, chipOf, mainOf, newRuntimeChat } from '../fixtures.ts'
import { viteUrl } from '../stack-ports.ts'

export * from '../fixtures.ts'

export const machineSectionOf = (page: Page) => mainOf(page).getByRole('region', { name: 'My machine' })
export const machineToolOf = (page: Page, toolName: string) =>
  machineSectionOf(page).getByRole('button', { name: new RegExp(`^(Use ${toolName}|✓ ${toolName} connected)$`) })
export const newMachineSession = async (page: Page, name: string, option = 'Local · Claude Code') => {
  const chatId = await newRuntimeChat(page, name, option)
  await expect(chipOf(page, 'any')).toHaveText(`${option.replace('Local · ', '')} · subscription`)
  return chatId
}
export const urlOf = (command: string) => `${viteUrl}/h/${command.match(/\/h\/([A-Z0-9]{8})\b/)?.[1]}`

const hostProgram = new URL('../../../host/src/main.ts', import.meta.url).pathname
export const gibibyte = 1024 ** 3

type HostSystem = { cpus: number; memoryBytes: number; rootless: boolean; limitsEnforced: boolean }
type HostProcess = { output: () => string; exited: Promise<number | null>; stop: () => Promise<void> }
type FakeHost = { closed: Promise<string> }
type Hosts = {
  start: (url: string, stateDirectory?: string) => HostProcess
  newStateDirectory: () => string
  fake: (url: string, system: Partial<HostSystem>) => FakeHost
}

type FakeMachine = { closed: Promise<string>; heartbeat: (signedIn: string[]) => void }
type PairingOptions = { personal?: boolean; signedIn?: string[] }

export const hostTest = base.extend<{ hosts: Hosts; pair: (url: string, options: PairingOptions) => FakeMachine }>({
  hosts: async ({ browserName: _ }, use) => {
    const processes: ChildProcess[] = []
    const sockets: WebSocket[] = []
    const stateDirectories: string[] = []
    const newStateDirectory = () => {
      const directory = mkdtempSync(join(tmpdir(), 'spyria-test-host-'))
      stateDirectories.push(directory)
      return directory
    }
    await use({
      newStateDirectory,
      start: (url, stateDirectory = newStateDirectory()) => {
        const child = spawn('bun', [hostProgram, url], {
          env: { ...process.env, SPYRIA_HOST_STATE_DIR: stateDirectory, SPYRIA_HOST_PREFIX: 'spyria-test-e2e-' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        processes.push(child)
        let output = ''
        const collect = (chunk: Buffer) => {
          output += chunk.toString()
        }
        child.stdout?.on('data', collect)
        child.stderr?.on('data', collect)
        const exited = new Promise<number | null>((resolve) => child.on('exit', resolve))
        return {
          output: () => output,
          exited,
          stop: async () => {
            if (child.exitCode !== null || child.signalCode !== null) return
            child.kill('SIGTERM')
            await exited
          },
        }
      },
      fake: (url, system) => {
        const { origin, pathname } = new URL(url)
        const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/host`)
        sockets.push(socket)
        const send = (frame: object) => socket.send(JSON.stringify(frame))
        socket.onopen = () => send({ type: 'claim', code: pathname.split('/').at(-1) })
        socket.onmessage = (message) => {
          const frame = JSON.parse(String(message.data))
          if (frame.type === 'ping') send({ type: 'pong' })
          if (frame.type === 'token')
            send({
              type: 'hello',
              token: frame.token,
              system: {
                cpus: 4,
                memoryBytes: 8 * gibibyte,
                dockerVersion: '29.0.0',
                rootless: false,
                cgroupDriver: 'systemd',
                limitsEnforced: true,
                ...system,
              },
            })
        }
        return { closed: new Promise((resolve) => socket.addEventListener('close', (event) => resolve(event.reason))) }
      },
    })
    for (const socket of sockets) socket.close()
    for (const child of processes) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    for (const directory of stateDirectories) rmSync(directory, { recursive: true, force: true })
  },
  pair: async ({ browserName: _ }, use) => {
    const sockets: WebSocket[] = []
    await use((url, { personal, signedIn }) => {
      const { origin, pathname } = new URL(url)
      const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/host`)
      sockets.push(socket)
      const send = (frame: object) => socket.send(JSON.stringify(frame))
      socket.onopen = () => send({ type: 'claim', code: pathname.split('/').at(-1) })
      socket.onmessage = (message) => {
        const frame = JSON.parse(String(message.data))
        if (frame.type === 'ping') send({ type: 'pong' })
        if (frame.type === 'cmd') send({ type: 'res', id: frame.id, data: frame.op === 'status' ? 'missing' : null })
        if (frame.type === 'token')
          send({
            type: 'hello',
            token: frame.token,
            personal,
            signedIn,
            system: {
              cpus: 8,
              memoryBytes: 16 * 1024 ** 3,
              dockerVersion: '29.0.0',
              rootless: false,
              cgroupDriver: 'cgroupfs',
              limitsEnforced: true,
            },
          })
      }
      return {
        heartbeat: (heartbeatSignedIn) =>
          send({ type: 'heartbeat', memoryFreeBytes: 8 * 1024 ** 3, running: 0, signedIn: heartbeatSignedIn }),
        closed: new Promise((resolve) => socket.addEventListener('close', (event) => resolve(event.reason))),
      }
    })
    for (const socket of sockets) socket.close()
  },
})
