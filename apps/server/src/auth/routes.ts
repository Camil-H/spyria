import type { Database } from '@hq/db/postgres'
import { type Context, Hono, type MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, getSignedCookie, setCookie, setSignedCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import type { Oidc } from './oidc.ts'
import { type Authentication, issueSessionToken, type SessionClaims } from './session-tokens.ts'
import { deleteSession, findLiveSessions, openSessions } from './sessions.ts'

export type AuthRouteSettings = {
  oidc: Oidc
  tokenSecret: string
  appOrigin: string
  database: Database
  authenticate: (authorization: string | undefined) => Promise<Authentication>
  testDatabaseByName?: (databaseName: string) => Database
}
type TestSettings = { db?: string; user?: string; tokenSeconds?: number }
type PopupResult = { status: 'signed_in' } | { status: 'not_invited'; email: string } | { status: 'failed' }

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
  const popup = (context: Context, result: PopupResult, status: 200 | 400 | 403 = 200) =>
    context.html(
      `<!doctype html><meta charset="utf-8"><title>Signing in to HQ</title><script>window.opener?.postMessage(${JSON.stringify(result).replaceAll('<', '\\u003c')}, ${JSON.stringify(appOrigin)});window.close()</script>`,
      status,
    )
  const completeSignIn = async (
    context: Context,
    scope: ReturnType<typeof scopeOf>,
    { userId, email, workspaceId }: { userId?: string; email: string; workspaceId?: string },
  ) => {
    const opened = userId === undefined ? [] : await openSessions(scope.database, userId, workspaceId)
    if (opened.length === 0) return popup(context, { status: 'not_invited', email }, 403)
    for (const session of opened) setSessionCookie(context, appOrigin, session)
    return popup(context, { status: 'signed_in' })
  }
  const sameAppOnly: MiddlewareHandler = async (context, next) => {
    if (context.req.header('origin') !== appOrigin || context.req.header('x-hq-csrf') !== '1')
      return context.json({ error: 'forbidden' }, 403)
    await next()
  }
  const sessionIdOf = (context: Context, workspaceId: string) =>
    getCookie(context, `${sessionCookiePrefix}${workspaceId}`) ?? ''

  return new Hono()
    .use('/renew', sameAppOnly)
    .use('/logout', sameAppOnly)
    .get('/login', async (context) => {
      const scope = scopeOf(context)
      const workspaceId = context.req.query('workspace')
      if (scope.testUserId) return completeSignIn(context, scope, { userId: scope.testUserId, email: '', workspaceId })
      const { url, login } = await oidc.authorizationUrl()
      await setSignedCookie(context, loginCookie, JSON.stringify({ ...login, workspaceId }), tokenSecret, {
        ...sessionCookieOptions(appOrigin),
        path: '/auth/callback',
        maxAge: loginCookieSeconds,
      })
      return context.redirect(url)
    })
    .get('/callback', async (context) => {
      const signedLogin = await getSignedCookie(context, tokenSecret, loginCookie)
      deleteCookie(context, loginCookie, { path: '/auth/callback' })
      const { workspaceId, ...login } = signedLogin ? JSON.parse(signedLogin) : { workspaceId: undefined }
      const email = signedLogin
        ? await oidc.verifiedEmailOf(new URL(context.req.url), login).catch(() => undefined)
        : undefined
      if (email === undefined) return popup(context, { status: 'failed' }, 400)
      const scope = scopeOf(context)
      const user = await scope.database.query.users.findFirst({ where: { email } })
      return completeSignIn(context, scope, { userId: user?.id, email, workspaceId })
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
      if (authentication.status !== 200) return context.json({ error: 'unauthorized' }, authentication.status)
      const workspaceId = await workspaceIdOfBody(context)
      const scope = scopeOf(context, authentication.databaseName)
      const [session] = await openSessions(scope.database, authentication.context.userId, workspaceId)
      if (!session) return context.json({ error: 'forbidden' }, 403)
      setSessionCookie(context, appOrigin, session)
      return context.json(await scope.issue(session))
    })
}
