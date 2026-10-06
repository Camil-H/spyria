import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, openSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  type Database,
  memberships,
  placeholderSecrets,
  resetDatabase,
  runtimeHosts,
  runtimes,
  sessions,
  users,
  workspaces,
} from '@hq/db/postgres'
import { createTestDatabase, dropDatabase, startZeroCache } from '@hq/db/testing'
import { createZeroStore, type WorkspaceSession } from '@hq/db/zero-store'
import { memberId, workspaceId } from '@hq/kernel'
import { type Browser, type BrowserContext, test as base } from '@playwright/test'
import { serverUrl, templateDatabaseName, viteUrl, zeroCachePortOf } from './stack-ports.ts'

export { expect } from '@playwright/test'

type ResetOptions = { runtimeHost: boolean; warmRuntimes: boolean }
export type WorkerStack = {
  databaseName: string
  zeroCacheURL: string
  database: Database
  reset: (options: ResetOptions) => Promise<void>
  stopRuntimeHost: () => Promise<void>
  startRuntimeHost: () => Promise<void>
}
type WarmRuntime = { runtime: typeof runtimes.$inferSelect; secrets: (typeof placeholderSecrets.$inferSelect)[] }
type AgentScript = { text?: string; wordDelayMilliseconds?: number; command?: string; steps?: object[] }

const aliceMemberId = 'member-alice'
const barrierMemberId = memberId('member-e2e-barrier')
const barrierWorkspaceId = workspaceId('workspace-e2e-barrier')
const barrierTimeoutMilliseconds = 15_000
const maximumResetAttempts = 5
const deadlockCode = '40P01'
const barrierSessionMilliseconds = 24 * 60 * 60 * 1000
const workerDatabaseNameOf = (workerIndex: number) => `hq_e2e_w${workerIndex}`
const hostProgram = new URL('../../host/src/main.ts', import.meta.url).pathname
const warmChatIds = ['chat-research', 'chat-setup-helper']
const runtimeReadyMilliseconds = 90_000
export const workerHostPrefixOf = (workerIndex: number) => `hq-test-e2e-w${workerIndex}-`

const docker = (...args: string[]) =>
  spawnSync('docker', args, { stdio: ['ignore', 'pipe', 'ignore'] }).stdout.toString()
export const removeDockerObjects = (namePrefix: string) => {
  const listed = (...command: string[]) =>
    docker(...command, '--filter', `name=^${namePrefix}`)
      .split('\n')
      .filter(Boolean)
  const containers = listed('ps', '-aq')
  if (containers.length > 0) docker('rm', '-f', ...containers)
  const volumes = listed('volume', 'ls', '-q')
  if (volumes.length > 0) docker('volume', 'rm', '-f', ...volumes)
  const networks = listed('network', 'ls', '-q')
  if (networks.length > 0) docker('network', 'rm', ...networks)
}

const postToServer = async (path: string, query: Record<string, string>, init: RequestInit = {}) => {
  const response = await fetch(`${serverUrl}${path}?${new URLSearchParams(query)}`, { method: 'POST', ...init })
  if (!response.ok) throw new Error(`POST ${path} failed with ${response.status}`)
  return response
}

const signIn = async (
  context: BrowserContext,
  workerStack: WorkerStack,
  user: string | null,
  tokenSeconds?: number,
) => {
  await context.addInitScript(
    (testStack) => {
      Object.assign(window, { hqTestStack: testStack })
    },
    { zeroCacheURL: workerStack.zeroCacheURL },
  )
  const signInQuery = { db: workerStack.databaseName, user, tokenSeconds: tokenSeconds?.toString() }
  const query = new URLSearchParams(
    Object.entries(signInQuery).filter((entry): entry is [string, string] => !!entry[1]),
  )
  const signedIn = await context.request.post(`${serverUrl}/test/sign-in?${query}`)
  if (!signedIn.ok()) throw new Error(`The test sign-in failed with ${signedIn.status()}`)
}

export const openPageAs = async (browser: Browser, workerStack: WorkerStack, user: string) => {
  const context = await browser.newContext({ baseURL: viteUrl, timezoneId: 'UTC' })
  await signIn(context, workerStack, user)
  const page = await context.newPage()
  await page.goto('/')
  return page
}

const pairRuntimeHost = async (database: Database, databaseName: string, workerIndex: number) => {
  const session = await (
    await postToServer('/test/token', { db: databaseName, user: aliceMemberId, workspace: 'workspace-acme' })
  ).json()
  const { id, code } = await (
    await postToServer(
      '/api/runtime-hosts',
      {},
      {
        headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: `e2e host ${workerIndex}` }),
      },
    )
  ).json()
  const stateDirectory = mkdtempSync(join(tmpdir(), 'hq-test-host-'))
  const hostRow = async () => (await database.select().from(runtimeHosts)).find((host) => host.id === id)
  const waitForStatus = async (isExpected: (status: string | undefined) => boolean) => {
    for (const deadline = Date.now() + 30_000; !isExpected((await hostRow())?.status); await sleep(100))
      if (Date.now() > deadline) throw new Error('The e2e runtime host did not change its status in time')
  }
  const logFile = openSync(join(tmpdir(), `hq-e2e-host-w${workerIndex}.log`), 'w')
  let hostProcess: ChildProcess | undefined
  const start = async () => {
    if (hostProcess) return
    hostProcess = spawn('bun', [hostProgram, `${serverUrl}/h/${code}`], {
      env: { ...process.env, HQ_HOST_STATE_DIR: stateDirectory, HQ_HOST_PREFIX: workerHostPrefixOf(workerIndex) },
      stdio: ['ignore', logFile, logFile],
    })
    await waitForStatus((status) => status === 'online')
  }
  const stop = async () => {
    hostProcess?.kill('SIGTERM')
    hostProcess = undefined
    await waitForStatus((status) => status !== 'online')
  }
  await start()
  const host = await hostRow()
  if (!host) throw new Error('The e2e runtime host row is missing')
  return {
    host,
    start,
    stop,
    release: () => {
      hostProcess?.kill('SIGTERM')
      rmSync(stateDirectory, { recursive: true, force: true })
    },
  }
}

const warmUp = async (database: Database, databaseName: string, chatIds: readonly string[]) => {
  for (const chatId of chatIds) await postToServer('/test/runtime', { db: databaseName, chat: chatId })
  const areRunning = async () => {
    const rows = (await database.select().from(runtimes)).filter((runtime) => chatIds.includes(runtime.chatId))
    return rows.every((runtime) => runtime.state === 'running') && rows.length === chatIds.length
  }
  for (const deadline = Date.now() + runtimeReadyMilliseconds; !(await areRunning()); await sleep(100))
    if (Date.now() > deadline) throw new Error('The warm e2e runtimes did not start')
}

type TestOptions = ResetOptions & {
  signedInAs: string | null
  tokenSeconds: number | undefined
  resetStack: undefined
  agentScript: (chatId: string, script: AgentScript) => Promise<void>
  failRuntimeCreation: (isFailing: boolean) => Promise<void>
}

export const test = base.extend<TestOptions, { workerStack: WorkerStack }>({
  signedInAs: [aliceMemberId, { option: true }],
  tokenSeconds: [undefined, { option: true }],
  workerStack: [
    async ({ browserName: _ }, use, workerInfo) => {
      const index = workerInfo.parallelIndex
      const releaseServerDatabase = () =>
        fetch(`${serverUrl}/test/release-database?db=${workerDatabaseNameOf(index)}`, { method: 'POST' })
      await releaseServerDatabase()
      await dropDatabase(workerDatabaseNameOf(index))
      const testDatabase = await createTestDatabase(templateDatabaseName, workerDatabaseNameOf(index))
      let epochNumber = 0
      let barrierSessionId: string | undefined
      let pairedHost: Awaited<ReturnType<typeof pairRuntimeHost>> | undefined
      const warmRuntimes = new Map<string, WarmRuntime>()
      const keepWarmRuntimes = async () => {
        const secrets = await testDatabase.database.select().from(placeholderSecrets)
        for (const runtime of await testDatabase.database.select().from(runtimes)) {
          const kept = warmRuntimes.get(runtime.chatId)
          const isWarm = runtime.state === 'running' || runtime.state === 'stopped'
          const isKept = kept?.runtime.id === runtime.id
          if (kept && (isKept ? !isWarm : isWarm))
            removeDockerObjects(`${workerHostPrefixOf(index)}rt-${kept.runtime.id}`)
          if (isKept && !isWarm) warmRuntimes.delete(runtime.chatId)
          if (isWarm)
            warmRuntimes.set(runtime.chatId, {
              runtime,
              secrets: secrets.filter((secret) => [runtime.apiKeyRef, runtime.llmTokenRef].includes(secret.ref)),
            })
        }
      }
      const writeReset = async (options: ResetOptions = { runtimeHost: false, warmRuntimes: false }) => {
        const epoch = `epoch-${workerInfo.workerIndex}-${++epochNumber}`
        const reset = () =>
          resetDatabase(testDatabase.database, async (transaction) => {
            await transaction.insert(users).values({ id: barrierMemberId, email: 'e2e-barrier@example.com' })
            await transaction.insert(workspaces).values({
              workspaceId: barrierWorkspaceId,
              name: epoch,
              createdBy: barrierMemberId,
              createdAt: new Date(),
            })
            await transaction.insert(memberships).values({
              workspaceId: barrierWorkspaceId,
              userId: barrierMemberId,
              role: 'member',
              displayName: 'Barrier',
            })
            if (barrierSessionId)
              await transaction.insert(sessions).values({
                workspaceId: barrierWorkspaceId,
                id: barrierSessionId,
                userId: barrierMemberId,
                createdAt: new Date(),
                expiresAt: new Date(Date.now() + barrierSessionMilliseconds),
              })
            if (!pairedHost) return
            await transaction
              .insert(runtimeHosts)
              .values({ ...pairedHost.host, removedAt: options.runtimeHost ? null : new Date() })
            if (!options.runtimeHost || !options.warmRuntimes) return
            for (const { runtime, secrets } of warmRuntimes.values()) {
              await transaction.insert(placeholderSecrets).values(secrets)
              await transaction
                .insert(runtimes)
                .values({ ...runtime, hostOnline: true, agentConversationId: null, lastActiveAt: new Date() })
            }
          })
        for (let attempt = 1; ; attempt++)
          try {
            await reset()
            return epoch
          } catch (error) {
            if (
              attempt === maximumResetAttempts ||
              (error as { cause?: { code?: string } }).cause?.code !== deadlockCode
            )
              throw error
          }
      }
      const firstEpoch = await writeReset()
      const zeroCache = await startZeroCache({
        databaseName: testDatabase.name,
        port: zeroCachePortOf(index),
        appId: `hqe2e${index}`,
        serverUrl,
      })
      const barrierSession = async () => {
        const query = new URLSearchParams({
          db: testDatabase.name,
          user: barrierMemberId,
          workspace: barrierWorkspaceId,
        })
        const session = await (await fetch(`${serverUrl}/test/token?${query}`, { method: 'POST' })).json()
        barrierSessionId = session.sessionId
        return session as WorkspaceSession
      }
      const barrier = createZeroStore({
        memberId: barrierMemberId,
        sessions: [await barrierSession()],
        renew: barrierSession,
        cacheURL: zeroCache.url,
        kvStore: 'mem',
      })
      const waitForEpoch = async (epoch: string) => {
        for (const deadline = Date.now() + barrierTimeoutMilliseconds; ; await sleep(10)) {
          if (barrier.read().workspaces.some((workspace) => workspace.name === epoch)) return
          if (Date.now() > deadline)
            throw new Error(`zero-cache did not replicate ${epoch} within ${barrierTimeoutMilliseconds} ms`)
        }
      }
      await waitForEpoch(firstEpoch)
      removeDockerObjects(workerHostPrefixOf(index))
      pairedHost = await pairRuntimeHost(testDatabase.database, testDatabase.name, index)
      await warmUp(testDatabase.database, testDatabase.name, warmChatIds)
      await use({
        databaseName: testDatabase.name,
        zeroCacheURL: zeroCache.url,
        database: testDatabase.database,
        reset: async (options) => {
          await pairedHost?.start()
          await keepWarmRuntimes()
          await waitForEpoch(await writeReset(options))
          const coldChatIds = warmChatIds.filter((chatId) => !warmRuntimes.has(chatId))
          if (options.runtimeHost && options.warmRuntimes && coldChatIds.length > 0)
            await warmUp(testDatabase.database, testDatabase.name, coldChatIds)
        },
        stopRuntimeHost: async () => pairedHost?.stop(),
        startRuntimeHost: async () => pairedHost?.start(),
      })
      pairedHost.release()
      removeDockerObjects(workerHostPrefixOf(index))
      await barrier.close()
      await zeroCache.stop()
      await releaseServerDatabase()
      await testDatabase.drop()
    },
    { scope: 'worker', timeout: 180_000 },
  ],
  runtimeHost: [true, { option: true }],
  warmRuntimes: [true, { option: true }],
  resetStack: [
    async ({ workerStack, context, signedInAs, tokenSeconds, runtimeHost, warmRuntimes }, use) => {
      await postToServer('/test/fake-llm-script', { db: workerStack.databaseName })
      await postToServer('/test/runtime-creation', { db: workerStack.databaseName, failing: 'false' })
      await workerStack.reset({ runtimeHost, warmRuntimes })
      await signIn(context, workerStack, signedInAs, tokenSeconds)
      await use(undefined)
    },
    { auto: true, timeout: 120_000 },
  ],
  agentScript: async ({ workerStack }, use) => {
    await use(async (chatId, script) => {
      await postToServer(
        '/test/fake-llm-script',
        { db: workerStack.databaseName, chat: chatId },
        { body: JSON.stringify(script) },
      )
    })
  },
  failRuntimeCreation: async ({ workerStack }, use) => {
    await use(async (isFailing) => {
      await postToServer('/test/runtime-creation', { db: workerStack.databaseName, failing: String(isFailing) })
    })
  },
})
