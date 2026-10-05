import { setTimeout as sleep } from 'node:timers/promises'
import { type Database, events, resetDatabase } from '@hq/db/postgres'
import { createTestDatabase, startZeroCache } from '@hq/db/testing'
import { memberId, workspaceId } from '@hq/kernel'
import { createApp } from './app.ts'
import { issueSessionToken } from './auth/session-tokens.ts'
import { openSessions } from './auth/sessions.ts'

export const testAuthSettings = {
  tokenSecret: 'integration-test-secret',
  appOrigin: 'http://localhost:5190',
  oidc: { issuer: 'http://localhost:5556/dex', clientId: 'hq', redirectUri: 'http://localhost:3100/auth/callback' },
}

export const acme = workspaceId('workspace-acme')
export const globex = workspaceId('workspace-globex')
export const alice = memberId('member-alice')
export const bob = memberId('member-bob')
export const aliceInAcme = { workspaceId: acme, userId: alice }
export const bobInAcme = { workspaceId: acme, userId: bob }
export const succeeded = {}
export const failedWith = (message: string) => ({ error: 'app', message })

export const issueTestSession = async (
  database: Database,
  workspaceId: string,
  userId: string,
  databaseName?: string,
) => {
  const [session] = await openSessions(database, userId, workspaceId)
  if (!session) throw new Error(`${userId} is not a member of ${workspaceId}`)
  const issued = await issueSessionToken(testAuthSettings.tokenSecret, session, { databaseName })
  return { ...issued, sessionId: session.sessionId }
}

export const sessionTokenOf = async (database: Database, workspaceId: string, userId: string) =>
  (await issueTestSession(database, workspaceId, userId)).token

export const waitFor = async (isDone: () => boolean | Promise<boolean>) => {
  for (const deadline = Date.now() + 10_000; !(await isDone()); await sleep(10))
    if (Date.now() > deadline) throw new Error('The condition was not met within 10 s')
}

const sharedAppId = 'hqtest'

const startSharedTestApp = async () => {
  const testDatabase = await createTestDatabase()
  const { database } = testDatabase
  const app = createApp({ database, ...testAuthSettings })
  const server = Bun.serve({ port: 0, fetch: app.fetch })
  const stopServerAndDatabase = async () => {
    await server.stop(true)
    await testDatabase.drop()
  }
  const zeroCache = await startZeroCache({
    databaseName: testDatabase.name,
    port: 4890,
    appId: sharedAppId,
    serverUrl: server.url.origin,
  }).catch(async (error) => {
    await stopServerAndDatabase()
    throw error
  })
  const resultOf = async (
    { workspaceId, userId }: { workspaceId: string; userId: string },
    name: string,
    args: Record<string, unknown>,
  ) => {
    const response = await app.request(`/api/mutate?schema=${sharedAppId}_0&appID=${sharedAppId}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await sessionTokenOf(database, workspaceId, userId)}` },
      body: JSON.stringify({
        clientGroupID: crypto.randomUUID(),
        mutations: [
          { type: 'custom', id: 1, clientID: crypto.randomUUID(), name, args: [args], timestamp: Date.now() },
        ],
        pushVersion: 1,
        timestamp: Date.now(),
        requestID: crypto.randomUUID(),
      }),
    })
    return ((await response.json()) as { mutations: { result: unknown }[] }).mutations[0]?.result
  }
  const eventsOf = async (chatId: string) =>
    (await database.select().from(events))
      .filter((event) => event.chatId === chatId)
      .toSorted((first, second) => first.seq - second.seq)
  const changesOf = async (chatId: string) =>
    (await eventsOf(chatId)).map(({ seq, type, actor, payload }) => ({ seq, type, actor, payload }))
  return {
    database,
    app,
    zeroCacheUrl: zeroCache.url,
    resultOf,
    eventsOf,
    changesOf,
    stop: async () => {
      await zeroCache.stop()
      await stopServerAndDatabase()
    },
  }
}

let sharedTestApp: ReturnType<typeof startSharedTestApp> | undefined

export const openSharedTestApp = async () => {
  sharedTestApp ??= startSharedTestApp()
  const testApp = await sharedTestApp
  await resetDatabase(testApp.database)
  return testApp
}

export const stopSharedTestApp = async () => (await sharedTestApp)?.stop()
