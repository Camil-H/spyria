import type { Database } from '@hq/db/postgres'
import { domainOfEmail, ssoEmailOf } from '@hq/workspace/server'
import { type Context, Hono } from 'hono'
import { deleteCookie, getCookie, getSignedCookie, setCookie, setSignedCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import { createOidc, type Oidc } from './oidc.ts'
import { type Authentication, errorByStatus, issueSessionToken, type SessionClaims } from './session-tokens.ts'
import { deleteSession, findLiveSessions, openSessions, signInUser } from './sessions.ts'
import { type SsoDependencies, type SsoProvider, ssoProviderOf } from './sso.ts'

export type AuthMode = 'dex' | 'sso'
type AuthRouteSettings = {
  oidc: Oidc
  redirectUri: string
  authMode: AuthMode
  sso: SsoDependencies
  tokenSecret: string
  appOrigin: string
  database: Database
  authenticate: (authorization: string | undefined) => Promise<Authentication>
  testDatabaseByName?: (databaseName: string) => Database
}
type TestSettings = { db?: string; user?: string; tokenSeconds?: number }
type PopupResult =
  | { status: 'signed_in' }
  | { status: 'not_invited'; email: string }
  | { status: 'unknown_domain'; domain: string }
  | { status: 'failed' }

const sessionCookiePrefix = 'hq_s_'
const loginCookie = 'hq_login'
export const testCookie = 'hq_test'
const loginCookieSeconds = 5 * 60

export const sessionCookieOptions = (appOrigin: string) =>
  ({
    httpOnly: true,
    sameSite: 'Lax',
    path: '/auth',
    secure: new URL(appOrigin).hostname !== 'localhost',
    maxAge: 7 * 24 * 60 * 60,
  }) as const

export const setSessionCookie = (context: Context, appOrigin: string, session: SessionClaims) =>
  setCookie(context, `${sessionCookiePrefix}${session.workspaceId}`, session.sessionId, sessionCookieOptions(appOrigin))

const workspaceIdOfBody = async (context: Context) => {
  const body = await context.req.json().catch(() => null)
  if (typeof body?.workspaceId !== 'string') throw new HTTPException(400, { message: 'workspaceId is required' })
  return body.workspaceId as string
}

export const createAuthRoutes = ({
  oidc,
  redirectUri,
  authMode,
  sso,
  tokenSecret,
  appOrigin,
  database,
  authenticate,
  testDatabaseByName,
}: AuthRouteSettings) => {
  const scopeOf = (context: Context, tokenDatabaseName?: string) => {
    const testSettings: TestSettings = testDatabaseByName ? JSON.parse(getCookie(context, testCookie) ?? '{}') : {}
    const databaseName = tokenDatabaseName ?? testSettings.db
    return {
      database: databaseName && testDatabaseByName ? testDatabaseByName(databaseName) : database,
      testUserId: testSettings.user,
      issue: (session: SessionClaims) =>
        issueSessionToken(tokenSecret, session, { databaseName, lifetimeSeconds: testSettings.tokenSeconds }),
    }
  }
  const ssoClients = new Map<string, Oidc>()
  const ssoClientOf = async (provider: SsoProvider) => {
    const clientKey = `${provider.issuer} ${provider.clientId} ${provider.encryptedClientSecret}`
    const known = ssoClients.get(clientKey)
    if (known) return known
    if (!sso.secretBox) throw new Error('HQ_SECRETS_KEY is required in sso mode')
    const client = createOidc({
      issuer: provider.issuer,
      clientId: provider.clientId,
      clientSecret: await sso.secretBox.open(provider.encryptedClientSecret),
      redirectUri,
      emailOf: (claims) => ssoEmailOf(provider.preset, claims),
    })
    ssoClients.set(clientKey, client)
    return client
  }
  const popup = (context: Context, result: PopupResult, status: 200 | 400 | 403 | 404 = 200) =>
    context.html(
      `<!doctype html><meta charset="utf-8"><title>Signing in to HQ</title><script>window.opener?.postMessage(${JSON.stringify(result).replaceAll('<', '\\u003c')}, ${JSON.stringify(appOrigin)});window.close()</script>`,
      status,
    )
  const completeSignIn = async (
    context: Context,
    scope: ReturnType<typeof scopeOf>,
    { userId, email, workspaceId, issuer }: { userId?: string; email: string; workspaceId?: string; issuer?: string },
  ) => {
    const opened = userId === undefined ? [] : await openSessions(scope.database, userId, workspaceId, issuer)
    if (opened.length === 0) return popup(context, { status: 'not_invited', email }, 403)
    for (const session of opened) setSessionCookie(context, appOrigin, session)
    return popup(context, { status: 'signed_in' })
  }
  const sessionIdOf = (context: Context, workspaceId: string) =>
    getCookie(context, `${sessionCookiePrefix}${workspaceId}`) ?? ''

  return new Hono()
    .use('/:action{renew|logout}', async (context, next) => {
      if (context.req.header('origin') !== appOrigin || context.req.header('x-hq-csrf') !== '1')
        return context.json({ error: 'forbidden' }, 403)
      await next()
    })
    .get('/mode', (context) => context.json({ authMode }))
    .get('/login', async (context) => {
      const scope = scopeOf(context)
      const workspaceId = context.req.query('workspace')
      if (scope.testUserId) return completeSignIn(context, scope, { userId: scope.testUserId, email: '', workspaceId })
      const domain = domainOfEmail(context.req.query('email') ?? '')
      const provider =
        authMode === 'sso' ? await ssoProviderOf(scope.database, workspaceId ? { workspaceId } : { domain }) : undefined
      if (authMode === 'sso' && !provider)
        return popup(context, workspaceId ? { status: 'failed' } : { status: 'unknown_domain', domain }, 404)
      const { url, login } = await (provider ? await ssoClientOf(provider) : oidc).authorizationUrl()
      const signedLogin = JSON.stringify({ ...login, workspaceId, providerWorkspaceId: provider?.workspaceId })
      await setSignedCookie(context, loginCookie, signedLogin, tokenSecret, {
        ...sessionCookieOptions(appOrigin),
        path: '/auth/callback',
        maxAge: loginCookieSeconds,
      })
      return context.redirect(url)
    })
    .get('/callback', async (context) => {
      const signedLogin = await getSignedCookie(context, tokenSecret, loginCookie)
      deleteCookie(context, loginCookie, { path: '/auth/callback' })
      const { workspaceId, providerWorkspaceId, ...login } = signedLogin ? JSON.parse(signedLogin) : {}
      const scope = scopeOf(context)
      const provider =
        authMode === 'sso' && providerWorkspaceId
          ? await ssoProviderOf(scope.database, { workspaceId: providerWorkspaceId })
          : undefined
      const client = authMode === 'dex' ? oidc : provider && (await ssoClientOf(provider))
      const identity =
        signedLogin && client
          ? await client.verifiedIdentityOf(new URL(context.req.url), login).catch(() => undefined)
          : undefined
      if (identity === undefined) return popup(context, { status: 'failed' }, 400)
      const issuer = provider?.issuer
      const { userId, email } = await signInUser(scope.database, { ...identity, issuer }, authMode === 'sso')
      return completeSignIn(context, scope, { userId, email, workspaceId, issuer })
    })
    .get('/sessions', async (context) => {
      const scope = scopeOf(context)
      const sessionIdByWorkspace = Object.entries(getCookie(context)).flatMap(([name, sessionId]) =>
        name.startsWith(sessionCookiePrefix)
          ? [[name.slice(sessionCookiePrefix.length), sessionId] as [string, string]]
          : [],
      )
      const liveSessions = await findLiveSessions(scope.database, sessionIdByWorkspace)
      const userId = liveSessions.toSorted((first, second) => +second.createdAt - +first.createdAt)[0]?.userId
      const sessions = await Promise.all(liveSessions.filter((session) => session.userId === userId).map(scope.issue))
      return context.json({ userId, sessions })
    })
    .post('/renew', async (context) => {
      const workspaceId = await workspaceIdOfBody(context)
      const scope = scopeOf(context)
      const [session] = await findLiveSessions(scope.database, [[workspaceId, sessionIdOf(context, workspaceId)]])
      return session ? context.json(await scope.issue(session)) : context.json({ error: 'unauthorized' }, 401)
    })
    .post('/logout', async (context) => {
      const workspaceId = await workspaceIdOfBody(context)
      await deleteSession(scopeOf(context).database, workspaceId, sessionIdOf(context, workspaceId))
      deleteCookie(context, `${sessionCookiePrefix}${workspaceId}`, { path: '/auth' })
      return context.body(null, 204)
    })
    .post('/sessions', async (context) => {
      const authentication = await authenticate(context.req.header('authorization'))
      if (authentication.status !== 200)
        return context.json({ error: errorByStatus[authentication.status] }, authentication.status)
      const workspaceId = await workspaceIdOfBody(context)
      const scope = scopeOf(context, authentication.databaseName)
      const [session] = await openSessions(scope.database, authentication.context.userId, workspaceId)
      if (!session) return context.json({ error: 'forbidden' }, 403)
      setSessionCookie(context, appOrigin, session)
      return context.json(await scope.issue(session))
    })
}
