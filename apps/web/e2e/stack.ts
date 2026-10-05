import { setTimeout as sleep } from 'node:timers/promises'
import { type Database, memberships, resetDatabase, sessions, users, workspaces } from '@hq/db/postgres'
import { createTestDatabase, dropDatabase, startZeroCache } from '@hq/db/testing'
import { createZeroStore, type WorkspaceSession } from '@hq/db/zero-store'
import { memberId, workspaceId } from '@hq/kernel'
import { test as base } from '@playwright/test'
import { serverUrl, templateDatabaseName, zeroCachePortOf } from './stack-ports.ts'

export { expect } from '@playwright/test'

type WorkerStack = { databaseName: string; zeroCacheURL: string; database: Database; reset: () => Promise<void> }

const aliceMemberId = 'member-alice'
const barrierMemberId = memberId('member-e2e-barrier')
const barrierWorkspaceId = workspaceId('workspace-e2e-barrier')
const barrierTimeoutMilliseconds = 15_000
const maximumResetAttempts = 5
const deadlockCode = '40P01'
const barrierSessionMilliseconds = 24 * 60 * 60 * 1000
const workerDatabaseNameOf = (workerIndex: number) => `hq_e2e_w${workerIndex}`

type TestOptions = { signedInAs: string | null; tokenSeconds: number | undefined; resetStack: undefined }

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
      const writeReset = async () => {
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
      await use({
        databaseName: testDatabase.name,
        zeroCacheURL: zeroCache.url,
        database: testDatabase.database,
        reset: async () => waitForEpoch(await writeReset()),
      })
      await barrier.close()
      await zeroCache.stop()
      await releaseServerDatabase()
      await testDatabase.drop()
    },
    { scope: 'worker', timeout: 60_000 },
  ],
  resetStack: [
    async ({ workerStack, context, signedInAs, tokenSeconds }, use) => {
      await context.addInitScript(
        (testStack) => {
          Object.assign(window, { hqTestStack: testStack })
        },
        { zeroCacheURL: workerStack.zeroCacheURL },
      )
      await workerStack.reset()
      const signIn = { db: workerStack.databaseName, user: signedInAs, tokenSeconds: tokenSeconds?.toString() }
      const query = new URLSearchParams(Object.entries(signIn).filter((entry): entry is [string, string] => !!entry[1]))
      const signedIn = await context.request.post(`${serverUrl}/test/sign-in?${query}`)
      if (!signedIn.ok()) throw new Error(`The test sign-in failed with ${signedIn.status()}`)
      await use(undefined)
    },
    { auto: true },
  ],
})
