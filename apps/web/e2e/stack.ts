import { setTimeout as sleep } from 'node:timers/promises'
import { type Browser, type BrowserContext, test as base } from '@playwright/test'
import {
  type Database,
  memberships,
  resetDatabase,
  runtimeHosts,
  runtimes,
  sessions,
  users,
  workspaceRoles,
  workspaces,
} from '@spyria/db/postgres'
import {
  createTestDatabase,
  dropDatabase,
  prepareSeededGatewayKeys,
  shareTestCrm,
  startZeroCache,
  testGatewayAt,
} from '@spyria/db/testing'
import { createZeroStore, type WorkspaceSession } from '@spyria/db/zero-store'
import { memberId, workspaceId } from '@spyria/kernel'
import { gatewayUrl, serverUrl, templateDatabaseName, viteUrl, zeroCachePortOf } from './stack-ports.ts'

export { expect } from '@playwright/test'

type ResetOptions = { runtimeHost: boolean; warmRuntimes: boolean; sharedCrm: boolean }
type PairedHost = {
  host: typeof runtimeHosts.$inferSelect
  start: () => Promise<void>
  stop: () => Promise<void>
  warmRuntimes: Map<string, WarmRuntime>
}
export type WorkerStack = {
  databaseName: string
  zeroCacheURL: string
  database: Database
  reset: (options: ResetOptions) => Promise<void>
  stopRuntimeHost: () => Promise<void>
  startRuntimeHost: () => Promise<void>
  gateway: <Result>(path: string) => Promise<Result>
  fakeHost: (query?: Record<string, string>) => Promise<{ id: string; conversations: FakeHostConversation[] }>
  setGatewayReachable: (isReachable: boolean) => Promise<void>
}
type FakeHostConversation = {
  agent: { acp_command: string[]; acp_model?: string; acp_thought_level?: string; acp_resume_session_id?: string }
  parent_conversation_id?: string
}
type WarmRuntime = { runtime: typeof runtimes.$inferSelect }
const testGateway = testGatewayAt(gatewayUrl)
export type AgentScript = {
  text?: string
  wordDelayMilliseconds?: number
  hold?: string
  command?: string
  steps?: object[]
  route?: object | string
  delegateRoute?: object | string
  subagents?: Record<string, object>
  summary?: string
}

const aliceMemberId = 'member-alice'
const barrierMemberId = memberId('member-e2e-barrier')
const barrierWorkspaceId = workspaceId('workspace-e2e-barrier')
const barrierTimeoutMilliseconds = 15_000
const maximumResetAttempts = 5
const deadlockCode = '40P01'
const barrierSessionMilliseconds = 24 * 60 * 60 * 1000
const workerDatabaseNameOf = (workerIndex: number) => `spyria_e2e_w${workerIndex}`
const warmChatIds = ['chat-research', 'chat-setup-helper']
const runtimeReadyMilliseconds = 90_000

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
      Object.assign(window, { spyriaTestStack: testStack })
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

export const openPageAs = async (
  browser: Browser,
  workerStack: WorkerStack,
  user: string | null,
  baseURL = viteUrl,
) => {
  const context = await browser.newContext({ baseURL, timezoneId: 'UTC' })
  await signIn(context, workerStack, user)
  const page = await context.newPage()
  await page.goto('/')
  return page
}

export const runtimeStateOf = async (workerStack: WorkerStack, chatId: string) =>
  (await workerStack.database.$client`select state from runtimes where chat_id = ${chatId}`)[0]?.state

const pairFakeHost = async (database: Database, databaseName: string): Promise<PairedHost> => {
  const setOnline = (isOnline: boolean) =>
    postToServer('/test/fake-host', { db: databaseName, online: String(isOnline) })
  const { id } = await (await postToServer('/test/fake-host', { db: databaseName })).json()
  const host = (await database.select().from(runtimeHosts)).find((row) => row.id === id)
  if (!host) throw new Error('The e2e fake runtime host row is missing')
  return {
    host,
    start: async () => {
      await setOnline(true)
    },
    stop: async () => {
      await setOnline(false)
    },
    warmRuntimes: new Map(),
  }
}

const warmUp = async (database: Database, databaseName: string, chatIds: readonly string[]) => {
  for (const chatId of chatIds) await postToServer('/test/runtime', { db: databaseName, chat: chatId })
  const areRunning = async () => {
    const rows = (await database.select().from(runtimes)).filter((runtime) => chatIds.includes(runtime.chatId))
    const failed = rows.find((runtime) => runtime.state === 'failed')
    if (failed) throw new Error(`The warm e2e runtime of ${failed.chatId} failed: ${failed.failure}`)
    return rows.every((runtime) => runtime.state === 'running') && rows.length === chatIds.length
  }
  for (const deadline = Date.now() + runtimeReadyMilliseconds; !(await areRunning()); await sleep(100))
    if (Date.now() > deadline) throw new Error('The warm e2e runtimes did not start')
}

type TestOptions = ResetOptions & {
  signedInAs: string | null
  tokenSeconds: number | undefined
  resetStack: undefined
  pendingQueriesOnFailure: undefined
  agentScript: (chatId: string, script: AgentScript) => Promise<void>
  failRuntimeCreation: (isFailing: boolean) => Promise<void>
  refuseNextMessage: () => Promise<void>
  fakeBootHold: string | undefined
  release: (name: string) => Promise<void>
  reached: (name: string) => Promise<void>
  heldCommand: (name: string) => string
}

export const test = base.extend<TestOptions, { workerStack: WorkerStack }>({
  signedInAs: [aliceMemberId, { option: true }],
  tokenSeconds: [undefined, { option: true }],
  fakeBootHold: [undefined, { option: true }],
  workerStack: [
    async ({ browserName: _ }, use, workerInfo) => {
      const index = workerInfo.parallelIndex
      const releaseServerDatabase = () =>
        fetch(`${serverUrl}/test/release-database?db=${workerDatabaseNameOf(index)}`, { method: 'POST' })
      await releaseServerDatabase()
      await dropDatabase(workerDatabaseNameOf(index))
      const testDatabase = await createTestDatabase(templateDatabaseName, workerDatabaseNameOf(index))
      let epochNumber = 0
      let seededGatewayKeys: Awaited<ReturnType<typeof prepareSeededGatewayKeys>> | undefined
      let barrierSessionId: string | undefined
      let pairedHost: PairedHost | undefined
      const keepWarmRuntimes = async () => {
        const warmRuntimes = pairedHost?.warmRuntimes
        if (!warmRuntimes) return
        for (const runtime of await testDatabase.database.select().from(runtimes)) {
          if (!warmChatIds.includes(runtime.chatId)) continue
          const kept = warmRuntimes.get(runtime.chatId)
          const isWarm = runtime.state === 'running' || runtime.state === 'stopped'
          const isKept = kept?.runtime.id === runtime.id
          if (isKept && !isWarm) warmRuntimes.delete(runtime.chatId)
          if (isWarm) warmRuntimes.set(runtime.chatId, { runtime })
        }
      }
      const writeReset = async (
        options: ResetOptions = { runtimeHost: false, warmRuntimes: false, sharedCrm: true },
      ) => {
        const epoch = `epoch-${workerInfo.workerIndex}-${++epochNumber}`
        const [gatewaySync] = await testDatabase.database.$client<{ isPending: boolean }[]>`
          select exists(select 1 from jobs where type = 'profile.gateway-sync' and state in ('queued', 'running'))
            as "isPending"`
        const writeSeededGatewayKeys = await prepareSeededGatewayKeys(
          testGateway,
          gatewaySync?.isPending ? undefined : seededGatewayKeys,
        )
        seededGatewayKeys = writeSeededGatewayKeys
        const reset = () =>
          resetDatabase(testDatabase.database, async (transaction) => {
            await writeSeededGatewayKeys(transaction)
            if (options.sharedCrm) await shareTestCrm(transaction)
            await transaction.insert(users).values({ id: barrierMemberId, email: 'e2e-barrier@example.com' })
            await transaction.insert(workspaces).values({
              workspaceId: barrierWorkspaceId,
              name: epoch,
              createdBy: barrierMemberId,
              createdAt: new Date(),
            })
            await transaction
              .insert(workspaceRoles)
              .values({ workspaceId: barrierWorkspaceId, id: 'member', name: 'Member', builtIn: true })
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
            for (const { runtime } of pairedHost.warmRuntimes.values()) {
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
        appId: `spyriae2e${index}`,
        serverUrl,
      })
      try {
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
        await use({
          databaseName: testDatabase.name,
          zeroCacheURL: zeroCache.url,
          database: testDatabase.database,
          reset: async (options) => {
            await keepWarmRuntimes()
            pairedHost ??= await pairFakeHost(testDatabase.database, testDatabase.name)
            const warmSandboxes = [...pairedHost.warmRuntimes.values()].map(
              ({ runtime }) => `${runtime.workspaceId}/${runtime.id}`,
            )
            await postToServer('/test/fake-host', { db: testDatabase.name, keepAgentsOf: warmSandboxes.join(',') })
            await pairedHost.start()
            await waitForEpoch(await writeReset(options))
            const { warmRuntimes } = pairedHost
            const coldChatIds = warmChatIds.filter((chatId) => !warmRuntimes.has(chatId))
            if (options.runtimeHost && options.warmRuntimes && coldChatIds.length > 0)
              await warmUp(testDatabase.database, testDatabase.name, coldChatIds)
          },
          stopRuntimeHost: async () => pairedHost?.stop(),
          startRuntimeHost: async () => pairedHost?.start(),
          gateway: (path) => testGateway.call(path),
          fakeHost: async (query = {}) =>
            (await postToServer('/test/fake-host', { db: testDatabase.name, ...query })).json(),
          setGatewayReachable: async (isReachable) => {
            await postToServer('/test/gateway', { db: testDatabase.name, reachable: String(isReachable) })
          },
        })
        await barrier.close()
      } finally {
        await zeroCache.stop()
      }
      await releaseServerDatabase()
      await testDatabase.drop()
    },
    { scope: 'worker', timeout: 180_000 },
  ],
  runtimeHost: [true, { option: true }],
  warmRuntimes: [true, { option: true }],
  sharedCrm: [true, { option: true }],
  resetStack: [
    async (
      { workerStack, context, signedInAs, tokenSeconds, runtimeHost, warmRuntimes, sharedCrm, fakeBootHold },
      use,
    ) => {
      await postToServer('/test/fake-llm-script', { db: workerStack.databaseName })
      await postToServer('/test/fake-boot', { db: workerStack.databaseName })
      await postToServer('/test/runtime-creation', { db: workerStack.databaseName, failing: 'false' })
      await workerStack.setGatewayReachable(true)
      await workerStack.reset({ runtimeHost, warmRuntimes, sharedCrm })
      if (fakeBootHold) await postToServer('/test/fake-boot', { db: workerStack.databaseName, hold: fakeBootHold })
      await signIn(context, workerStack, signedInAs, tokenSeconds)
      await use(undefined)
    },
    { auto: true, timeout: 120_000 },
  ],
  pendingQueriesOnFailure: [
    async ({ browser, context }, use, testInfo) => {
      await use(undefined)
      if (testInfo.status === testInfo.expectedStatus) return
      const pages = [...new Set([context, ...browser.contexts()])].flatMap((each) => each.pages())
      const pendingByPage = await Promise.all(
        pages.map(async (page) => ({
          url: page.url(),
          pending: await page
            .evaluate(() => (window as { spyriaPendingQueries?: () => unknown }).spyriaPendingQueries?.() ?? null)
            .catch((error: Error) => error.message),
        })),
      )
      await testInfo.attach('pending-zero-queries', {
        body: JSON.stringify(pendingByPage, null, 2),
        contentType: 'application/json',
      })
    },
    { auto: true },
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
  release: async ({ workerStack }, use) => {
    await use(async (name) => {
      await postToServer('/test/release', { db: workerStack.databaseName, name })
    })
  },
  reached: async ({ workerStack }, use) => {
    await use(async (name) => {
      await postToServer('/test/reached', { db: workerStack.databaseName, name })
    })
  },
  heldCommand: async ({ workerStack }, use) => {
    await use(
      (name) =>
        `curl -sf -X POST '${serverUrl}/test/hold?${new URLSearchParams({ db: workerStack.databaseName, name })}'`,
    )
  },
  failRuntimeCreation: async ({ workerStack }, use) => {
    await use(async (isFailing) => {
      await postToServer('/test/runtime-creation', { db: workerStack.databaseName, failing: String(isFailing) })
    })
  },
  refuseNextMessage: async ({ workerStack }, use) => {
    await use(async () => {
      await postToServer('/test/refuse-next-message', { db: workerStack.databaseName })
    })
  },
})
