import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page } from '@playwright/test'
import {
  machineTest as base,
  chipOf,
  machineSectionOf,
  machineToolOf,
  newRuntimeChat,
  openProfile,
  runsOnChipOf,
  runsOnOf,
  sessionOf,
} from '../fixtures.ts'
import type { WorkerStack } from '../stack.ts'
import { viteUrl } from '../stack-ports.ts'

export * from '../fixtures.ts'

export const openSession = async (page: Page, chipKind: Parameters<typeof chipOf>[1] = 'routed') => {
  if (!(await sessionOf(page).isVisible())) await chipOf(page, chipKind).click()
  await expect(sessionOf(page)).toBeVisible()
}
export const expectRunsOnLockedLocal = async (page: Page) => {
  await expect(runsOnOf(page)).toBeDisabled()
  await expect(runsOnOf(page)).toHaveText('Local')
}
export const runsOnStatusOf = (page: Page) => runsOnChipOf(page).getByRole('status', { name: 'Runtime' })
export const sessionStarted = (workerStack: WorkerStack, chatId: string) =>
  expect
    .poll(
      async () =>
        (await workerStack.database.$client`select agent_conversation_id from runtimes where chat_id = ${chatId}`)[0]
          ?.agent_conversation_id,
    )
    .toBeTruthy()
export const setUpButtonOf = (page: Page, toolName: string) =>
  machineToolOf(page, toolName).getByRole('button', { name: `Set up ${toolName}` })
export const newMachineSession = async (page: Page, name: string, option = 'Local · Claude Code') => {
  const chatId = await newRuntimeChat(page, name, option)
  await expect(chipOf(page, 'any')).toHaveText(`${option.replace('Local · ', '')} · subscription`)
  return chatId
}
export const urlOf = (command: string) => `${viteUrl}/h/${command.match(/\/h\/([A-Z0-9]{8})\b/)?.[1]}`
export const addMachine = async (page: Page) => {
  await openProfile(page, 'My machine')
  await machineSectionOf(page).getByRole('button', { name: 'Add my machine' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add my machine' })
  const command = await dialog.getByRole('textbox', { name: 'Command' }).inputValue()
  await dialog.getByRole('button', { name: 'Close' }).click()
  return urlOf(command)
}

const hostProgram = new URL('../../../host/src/main.ts', import.meta.url).pathname
export const gibibyte = 1024 ** 3
export const fakeHostVersions = { hostVersion: 'e2e', protocolVersion: 5 }

type HostSystem = { cpus: number; memoryBytes: number; rootless: boolean; limitsEnforced: boolean }
type HostProcess = { output: () => string; exited: Promise<number | null>; stop: () => Promise<void> }
type FakeHost = { closed: Promise<string> }
type Hosts = {
  start: (url: string, stateDirectory?: string) => HostProcess
  newStateDirectory: () => string
  fake: (url: string, system: Partial<HostSystem>) => FakeHost
}

type FakeMachine = { closed: Promise<string>; heartbeat: (signedIn: string[]) => void; disconnect: () => void }
type PairingOptions = { personal?: boolean; signedIn?: string[]; outdated?: boolean }

const connectFakeHostSocket = (
  url: string,
  { hello, answersCommands = false }: { hello: object; answersCommands?: boolean },
) => {
  const { origin, pathname } = new URL(url)
  const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/host`)
  const send = (frame: object) => socket.send(JSON.stringify(frame))
  socket.onopen = () => send({ type: 'claim', code: pathname.split('/').at(-1) })
  let refusedReason: string | undefined
  socket.onmessage = (message) => {
    const frame = JSON.parse(String(message.data))
    if (frame.type === 'ping') send({ type: 'pong' })
    if (frame.type === 'refused') refusedReason = String(frame.reason)
    if (answersCommands && frame.type === 'cmd')
      send({ type: 'res', id: frame.id, data: { status: 'missing', list: [] }[String(frame.op)] ?? null })
    if (frame.type === 'token') send({ type: 'hello', token: frame.token, ...hello })
  }
  const closed = new Promise<string>((resolve) =>
    socket.addEventListener('close', (event) => resolve(refusedReason ?? event.reason)),
  )
  return { socket, send, closed }
}

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
          env: { ...process.env, SPYRIA_HOST_STATE_DIR: stateDirectory, SPYRIA_DEPLOYMENT: 'spyria-test-e2e' },
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
        const { socket, closed } = connectFakeHostSocket(url, {
          hello: {
            ...fakeHostVersions,
            system: {
              cpus: 4,
              memoryBytes: 8 * gibibyte,
              dockerVersion: '29.0.0',
              rootless: false,
              cgroupDriver: 'systemd',
              limitsEnforced: true,
              ...system,
            },
          },
        })
        sockets.push(socket)
        return { closed }
      },
    })
    for (const socket of sockets) socket.close()
    for (const child of processes) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    for (const directory of stateDirectories) rmSync(directory, { recursive: true, force: true })
  },
  pair: async ({ browserName: _ }, use) => {
    const sockets: WebSocket[] = []
    await use((url, { personal, signedIn, outdated = false }) => {
      const { socket, send, closed } = connectFakeHostSocket(url, {
        answersCommands: true,
        hello: {
          personal,
          signedIn,
          ...(outdated ? {} : fakeHostVersions),
          system: {
            cpus: 8,
            memoryBytes: 16 * gibibyte,
            dockerVersion: '29.0.0',
            rootless: false,
            cgroupDriver: 'cgroupfs',
            limitsEnforced: true,
          },
        },
      })
      sockets.push(socket)
      return {
        heartbeat: (heartbeatSignedIn) =>
          send({ type: 'heartbeat', memoryFreeBytes: 8 * gibibyte, running: 0, signedIn: heartbeatSignedIn }),
        closed,
        disconnect: () => socket.close(),
      }
    })
    for (const socket of sockets) socket.close()
  },
})
