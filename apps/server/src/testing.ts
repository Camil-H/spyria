import type { Database } from '@hq/db/postgres'
import { issueSessionToken } from './auth/session-tokens.ts'
import { openSessions } from './auth/sessions.ts'

export const testAuthSettings = {
  tokenSecret: 'integration-test-secret',
  appOrigin: 'http://localhost:5190',
  oidc: { issuer: 'http://localhost:5556/dex', clientId: 'hq', redirectUri: 'http://localhost:3100/auth/callback' },
}

export const sessionTokenOf = async (database: Database, workspaceId: string, userId: string) => {
  const [session] = await openSessions(database, userId, workspaceId)
  if (!session) throw new Error(`${userId} is not a member of ${workspaceId}`)
  return (await issueSessionToken(testAuthSettings.tokenSecret, session)).token
}
