import { execSync } from 'node:child_process'
import { createMockSnapshot } from '@hq/db'
import { type Database, memberships, resetDatabase, users, workspaces } from '@hq/db/postgres'
import { createTestDatabase, startZeroCache } from '@hq/db/testing'
import { createZeroStore, type WorkspaceSession } from '@hq/db/zero-store'
import { memberId, workspaceId } from '@hq/kernel'
import { test as base } from '@playwright/test'
import { serverUrl, templateDatabaseName, workerDatabaseNameOf, zeroCachePortOf } from './stack-ports.ts'

export { expect } from '@playwright/test'

type WorkerStack = { databaseName: string; zeroCacheURL: string; database: Database; reset: () => Promise<void> }

const barrierMemberId = memberId('member-e2e-barrier')
const barrierWorkspaceId = workspaceId('workspace-e2e-barrier')
const barrierTimeoutMilliseconds = 15_000
const maximumResetAttempts = 5
const deadlockCode = '40P01'

const processTreeMemoryMegabytes = (rootProcessId: number) => {
  const processes = execSync('ps -axo pid=,ppid=,rss=')
    .toString()
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
  const treeProcessIds = new Set([rootProcessId])
  for (let depth = 0; depth < 4; depth++)
    for (const [processId = 0, parentProcessId = 0] of processes)
      if (treeProcessIds.has(parentProcessId)) treeProcessIds.add(processId)
  const residentKilobytes = processes.reduce(
    (total, [processId = 0, , rss = 0]) => (treeProcessIds.has(processId) ? total + rss : total),
    0,
  )
  return residentKilobytes / 1024
}

export const test = base.extend<{ resetStack: undefined }, { workerStack: WorkerStack }>({
  workerStack: [
    async ({ browserName: _ }, use, workerInfo) => {
      const index = workerInfo.parallelIndex
      const releaseServerDatabase = () =>
        fetch(`${serverUrl}/test/release-database?db=${workerDatabaseNameOf(index)}`, { method: 'POST' })
      await releaseServerDatabase()
      const testDatabase = await createTestDatabase(templateDatabaseName, workerDatabaseNameOf(index))
      let epochNumber = 0
      const writeReset = async () => {
        const epoch = `epoch-${workerInfo.workerIndex}-${++epochNumber}`
        const reset = () =>
          resetDatabase(testDatabase.database, createMockSnapshot(), async (transaction) => {
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
      const barrier = createZeroStore({
        memberId: barrierMemberId,
        defaultWorkspaceId: barrierWorkspaceId,
        cacheURL: zeroCache.url,
        kvStore: 'mem',
        fetchSession: async (workspace) => {
          const response = await fetch(`${serverUrl}/auth/dev-token`, {
            method: 'POST',
            body: JSON.stringify({ workspaceId: workspace, userId: barrierMemberId, db: testDatabase.name }),
          })
          return (await response.json()) as WorkspaceSession
        },
      })
      const waitForEpoch = (epoch: string) =>
        new Promise<void>((resolve, reject) => {
          const isReplicated = () => barrier.read().workspaces.some((workspace) => workspace.name === epoch)
          const timeout = setTimeout(() => {
            unsubscribe()
            reject(new Error(`zero-cache did not replicate ${epoch} within ${barrierTimeoutMilliseconds} ms`))
          }, barrierTimeoutMilliseconds)
          const settleIfReplicated = () => {
            if (!isReplicated()) return
            clearTimeout(timeout)
            unsubscribe()
            resolve()
          }
          const unsubscribe = barrier.subscribe(settleIfReplicated)
          settleIfReplicated()
        })
      await waitForEpoch(firstEpoch)
      await use({
        databaseName: testDatabase.name,
        zeroCacheURL: zeroCache.url,
        database: testDatabase.database,
        reset: async () => waitForEpoch(await writeReset()),
      })
      console.log(
        `worker ${index}: zero-cache resident memory ${processTreeMemoryMegabytes(zeroCache.pid).toFixed(0)} MB`,
      )
      await barrier.close()
      await zeroCache.stop()
      await releaseServerDatabase()
      await testDatabase.drop()
    },
    { scope: 'worker', timeout: 60_000 },
  ],
  resetStack: [
    async ({ workerStack, context }, use) => {
      await context.addInitScript(
        (testStack) => {
          Object.assign(window, { hqTestStack: testStack })
        },
        { zeroCacheURL: workerStack.zeroCacheURL, databaseName: workerStack.databaseName },
      )
      await workerStack.reset()
      await use(undefined)
    },
    { auto: true },
  ],
})
