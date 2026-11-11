import type { Database } from '@spyria/db/postgres'
import { DomainError } from '@spyria/kernel'
import {
  domainOfEmail,
  EmailNotConfirmed,
  entraObjectIdPattern,
  instanceAppFor,
  instanceAppPresets,
  type JoinBy,
  normalizedEmail,
  ssoCanBindByEmail,
  ssoEmailOf,
  ssoSubjectOf,
} from '@spyria/workspace/server'
import { type Context, Hono, type MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, getSignedCookie, setCookie, setSignedCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import type { RateLimitName } from '../rate-limits.ts'
import { createOidc, EmailRefused, type Oidc } from './oidc.ts'
import { isSameSecret } from './same-secret.ts'
import { type Authentication, errorByStatus, issueSessionToken, type SessionClaims } from './session-tokens.ts'
import { deleteSession, findLiveSessions, openSessions, signInUser } from './sessions.ts'
import {
  createFirstWorkspace,
  domainVerificationLinkPath,
  type FirstWorkspace,
  hasNoWorkspace,
  prepareFirstWorkspace,
  type SsoDependencies,
  type SsoProvider,
  ssoProviderOf,
  verifyDomainByToken,
} from './sso.ts'

export type AuthMode = 'dex' | 'sso'
type AuthRouteSettings = {
  oidc: Oidc
  redirectUri: string
  authMode: AuthMode
  sso: SsoDependencies
  tokenSecret: string
  appOrigin: string
  deployment: string
  version: string
  hostImage?: string
  setupToken?: string
  joinBy: JoinBy
  database: Database
  authenticate: (authorization: string | undefined) => Promise<Authentication>
  testDatabaseByName?: (databaseName: string) => Database
  closeSessionStreams: (database: Database, workspaceId: string, sessionId: string) => void
  rateLimited: (name: RateLimitName) => MiddlewareHandler
}
type TestSettings = { db?: string; user?: string; tokenSeconds?: number }
type PopupResult =
  | { status: 'signed_in' }
  | { status: 'not_invited'; email: string }
  | { status: 'unknown_domain'; domain: string }
  | { status: 'failed' }
  | { status: 'refused'; message: string }

const sessionCookiePrefix = 'spyria_s_'
const loginCookie = 'spyria_login'
const popupSelfCloseMilliseconds = 10_000
export const setupLinkNeededNotice = 'This Spyria is being set up: open the setup link to create its first workspace'
export const testCookie = 'spyria_test'
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

const domainErrorOnly = (error: unknown) => {
  if (error instanceof DomainError) return error
  throw error
}

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
  deployment,
  version,
  hostImage,
  setupToken,
  joinBy,
  database,
  authenticate,
  testDatabaseByName,
  closeSessionStreams,
  rateLimited,
}: AuthRouteSettings) => {
  const isSetupToken = (given: unknown) => isSameSecret(setupToken, given)
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
  const oidcOf = async (provider: FirstWorkspace['provider'], workspaceJoinBy: JoinBy) => {
    const instanceApp = provider.usesInstanceApp ? instanceAppFor(sso.instanceApps ?? {}, provider.preset) : undefined
    if (!instanceApp && !sso.secretBox) throw new Error('SPYRIA_SECRETS_KEY is required in sso mode')
    return createOidc({
      issuer: provider.issuer,
      clientId: instanceApp?.clientId ?? provider.clientId,
      clientSecret: instanceApp?.clientSecret ?? (await sso.secretBox?.open(provider.encryptedClientSecret)),
      redirectUri,
      emailOf: (claims) => ssoEmailOf(provider.preset, claims, workspaceJoinBy),
      subjectOf: (claims) => ssoSubjectOf(provider.preset, claims),
      canBindByEmailOf: (claims) => ssoCanBindByEmail(provider.preset, claims),
    })
  }
  const ssoClients = new Map<string, Oidc>()
  const ssoClientOf = async (provider: SsoProvider) => {
    const clientKey = `${provider.issuer} ${provider.clientId} ${provider.encryptedClientSecret} ${provider.joinBy}`
    const client = ssoClients.get(clientKey) ?? (await oidcOf(provider, provider.joinBy))
    ssoClients.set(clientKey, client)
    return client
  }
  const redirectToProvider = async (context: Context, client: Oidc, loginContext: object) => {
    const { url, login } = await client.authorizationUrl()
    await setSignedCookie(context, loginCookie, JSON.stringify({ ...login, ...loginContext }), tokenSecret, {
      ...sessionCookieOptions(appOrigin),
      path: '/auth/callback',
      maxAge: loginCookieSeconds,
    })
    return context.redirect(url)
  }
  const popup = (context: Context, result: PopupResult, status: 200 | 400 | 403 | 404 = 200) =>
    context.html(
      `<!doctype html><meta charset="utf-8"><title>Signing in to Spyria</title><script>window.opener?.postMessage(${JSON.stringify(result).replaceAll('<', '\\u003c')}, ${JSON.stringify(appOrigin)});window.opener ? setTimeout(close, ${popupSelfCloseMilliseconds}) : close()</script>`,
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
  const setupTokenLimited = rateLimited('setupToken')
  const setupLinkLimited: MiddlewareHandler = (context, next) =>
    context.req.query('setup') === undefined ? next() : setupTokenLimited(context, next)
  const sessionIdOf = (context: Context, workspaceId: string) =>
    getCookie(context, `${sessionCookiePrefix}${workspaceId}`) ?? ''

  return new Hono()
    .use('/:action{renew|logout}', async (context, next) => {
      if (context.req.header('origin') !== appOrigin || context.req.header('x-spyria-csrf') !== '1')
        return context.json({ error: 'forbidden' }, 403)
      await next()
    })
    .get('/mode', setupLinkLimited, async (context) => {
      const isBeingSetUp = authMode === 'sso' && (await hasNoWorkspace(scopeOf(context).database.$client))
      return context.json({
        authMode,
        joinBy,
        isBeingSetUp,
        canCreateWorkspace: isBeingSetUp && isSetupToken(context.req.query('setup')),
        instanceApps: authMode === 'sso' ? instanceAppPresets.filter((preset) => sso.instanceApps?.[preset]) : [],
      })
    })
    .post('/first-workspace', rateLimited('firstWorkspace'), async (context) => {
      if (authMode !== 'sso' || context.req.header('origin') !== appOrigin)
        return context.json({ error: 'forbidden' }, 403)
      const form = await context.req.parseBody()
      if (!isSetupToken(form.setupToken))
        return popup(context, { status: 'refused', message: setupLinkNeededNotice }, 403)
      const firstWorkspace = await prepareFirstWorkspace(scopeOf(context).database, sso, form, joinBy).catch(
        domainErrorOnly,
      )
      if (firstWorkspace instanceof Error)
        return popup(context, { status: 'refused', message: firstWorkspace.message }, 400)
      return redirectToProvider(context, await oidcOf(firstWorkspace.provider, firstWorkspace.joinBy), {
        firstWorkspace,
      })
    })
    .get(domainVerificationLinkPath.slice('/auth'.length), rateLimited('verificationLink'), async (context) => {
      const { database } = scopeOf(context)
      const verified = await verifyDomainByToken(database, context.req.query('token') ?? '').catch(() => undefined)
      if (!verified) return context.redirect(`${appOrigin}/?domainVerification=invalid`)
      const [session] = await findLiveSessions(database, [
        [verified.workspaceId, sessionIdOf(context, verified.workspaceId)],
      ])
      const appPath = session ? `/w/${verified.workspaceId}/settings/sso` : '/'
      return context.redirect(`${appOrigin}${appPath}?domainVerification=${encodeURIComponent(verified.domain)}`)
    })
    .get('/login', rateLimited('emailRouting'), async (context) => {
      const scope = scopeOf(context)
      const workspaceId = context.req.query('workspace')
      if (scope.testUserId) return completeSignIn(context, scope, { userId: scope.testUserId, email: '', workspaceId })
      const email = normalizedEmail(context.req.query('email') ?? '')
      const domain = domainOfEmail(email)
      const routed =
        authMode === 'sso' ? await ssoProviderOf(scope.database, workspaceId ? { workspaceId } : { email }) : undefined
      const provider =
        routed ??
        (authMode === 'sso' && joinBy === 'invited_address' && !workspaceId
          ? await ssoProviderOf(scope.database, { joinBy: 'invited_address' })
          : undefined)
      if (authMode === 'sso' && !provider)
        return popup(
          context,
          workspaceId
            ? { status: 'failed' }
            : joinBy === 'invited_address'
              ? { status: 'not_invited', email }
              : { status: 'unknown_domain', domain },
          404,
        )
      return redirectToProvider(context, provider ? await ssoClientOf(provider) : oidc, {
        workspaceId,
        providerWorkspaceId: provider?.workspaceId,
      })
    })
    .get('/callback', rateLimited('signInCallback'), async (context) => {
      const signedLogin = await getSignedCookie(context, tokenSecret, loginCookie)
      deleteCookie(context, loginCookie, { path: '/auth/callback' })
      const { workspaceId, providerWorkspaceId, firstWorkspace, ...login } = signedLogin ? JSON.parse(signedLogin) : {}
      const scope = scopeOf(context)
      const provider =
        authMode === 'sso' && providerWorkspaceId
          ? await ssoProviderOf(scope.database, { workspaceId: providerWorkspaceId })
          : undefined
      const client =
        authMode === 'dex'
          ? oidc
          : firstWorkspace
            ? await oidcOf(firstWorkspace.provider, firstWorkspace.joinBy)
            : provider && (await ssoClientOf(provider))
      const identity =
        signedLogin && client
          ? await client
              .verifiedIdentityOf(new URL(context.req.url), login)
              .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
          : undefined
      if (identity instanceof EmailRefused && identity.refusal === 'unconfirmed')
        return popup(context, { status: 'refused', message: new EmailNotConfirmed().message }, 403)
      if (identity === undefined || identity instanceof Error) return popup(context, { status: 'failed' }, 400)
      if (firstWorkspace) {
        const created = await createFirstWorkspace(scope.database, firstWorkspace, identity, sso).catch(domainErrorOnly)
        if (created instanceof Error) return popup(context, { status: 'refused', message: created.message }, 403)
        return completeSignIn(context, scope, { ...created, ...identity, issuer: firstWorkspace.provider.issuer })
      }
      const issuer = provider?.issuer
      const currentSubjectPattern = provider?.preset === 'microsoft' ? entraObjectIdPattern : undefined
      const { userId, email } = await signInUser(
        scope.database,
        { ...identity, issuer, currentSubjectPattern },
        authMode === 'sso',
      )
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
      if (!userId) return context.json({ sessions: [] })
      return context.json({ userId, sessions, deployment, version, hostImage })
    })
    .post('/renew', async (context) => {
      const workspaceId = await workspaceIdOfBody(context)
      const scope = scopeOf(context)
      const [session] = await findLiveSessions(scope.database, [[workspaceId, sessionIdOf(context, workspaceId)]])
      return session ? context.json(await scope.issue(session)) : context.json({ error: 'unauthorized' }, 401)
    })
    .post('/logout', async (context) => {
      const workspaceId = await workspaceIdOfBody(context)
      const { database } = scopeOf(context)
      const sessionId = sessionIdOf(context, workspaceId)
      await deleteSession(database, workspaceId, sessionId)
      closeSessionStreams(database, workspaceId, sessionId)
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
