import type { Database } from '@spyria/db/postgres'
import { createBoundedCache, DomainError } from '@spyria/kernel'
import {
  type AccountProvider,
  accountIssuerOf,
  accountProvidersOf,
  ClaimedDomainNotInvited,
  domainOfEmail,
  EmailNotConfirmed,
  entraObjectIdPattern,
  InstanceBeingSetUp,
  instanceAppFor,
  instanceAppPresets,
  normalizedEmail,
  type SignInScope,
  type SsoPreset,
  ssoCanBindByEmail,
  ssoEmailOf,
  ssoSubjectOf,
} from '@spyria/workspace/server'
import { type Context, Hono, type MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, getSignedCookie, setCookie, setSignedCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import type { RateLimitName } from '../rate-limits.ts'
import { claimsDomainOf } from './domain-claims.ts'
import { createOidc, EmailRefused, type Oidc } from './oidc.ts'
import { isSameSecret } from './same-secret.ts'
import { type Authentication, errorByStatus, issueSessionToken, type SessionClaims } from './session-tokens.ts'
import {
  deleteSession,
  emailOfUser,
  findLiveSessions,
  findMemberSessions,
  isSignedOutSince,
  openSessions,
  signInOf,
  signInThroughWorkspace,
  signInWithAccount,
  signOutMemberEverywhere,
  type VerifiedIdentity,
} from './sessions.ts'
import {
  confirmSsoSettings,
  createFirstWorkspace,
  createWorkspaceOfAccount,
  type FirstWorkspace,
  hasNoWorkspace,
  type PendingSso,
  prepareFirstWorkspace,
  prepareSsoSettings,
  type SsoDependencies,
  type SsoProvider,
  workspaceProviderOf,
  workspaceProvidersForEmail,
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
  database: Database
  authenticate: (authorization: string | undefined) => Promise<Authentication>
  testDatabaseByName?: (databaseName: string) => Database
  rateLimited: (name: RateLimitName) => MiddlewareHandler
}
type TestSettings = { db?: string; user?: string; tokenSeconds?: number }
type PopupResult =
  | { status: 'signed_in' }
  | { status: 'not_invited'; email: string }
  | { status: 'no_workspace' }
  | { status: 'failed' }
  | { status: 'refused'; message: string }
type LoginContext = {
  workspaceId?: string
  providerWorkspaceId?: string
  accountProvider?: AccountProvider
  firstWorkspace?: FirstWorkspace
  pendingSso?: PendingSso
}
type SignInProvider = { id: string; kind: SsoPreset; isWorkspaceSso: boolean }

const sessionCookiePrefix = 'spyria_s_'
const loginCookie = 'spyria_login'
const accountCookie = 'spyria_account'
const maximumCachedClients = 200
const accountProviderCookie = 'spyria_account_provider'
const accountCookieSeconds = 15 * 60
const accountProviderCookieSeconds = 365 * 24 * 60 * 60
const popupSelfCloseMilliseconds = 10_000
const workspaceProviderPrefix = 'workspace-'
export const setupLinkNeededNotice = new InstanceBeingSetUp().message
export const testCookie = 'spyria_test'
const loginCookieSeconds = 5 * 60
const userAgentMaxLength = 512

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

const userAgentOf = (context: Context) => (context.req.header('user-agent') ?? '').slice(0, userAgentMaxLength)

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
  database,
  authenticate,
  testDatabaseByName,
  rateLimited,
}: AuthRouteSettings) => {
  const isSetupToken = (given: unknown) => isSameSecret(setupToken, given)
  const accountProviders = authMode === 'sso' ? accountProvidersOf(sso.instanceApps ?? {}) : []
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
  const clients = createBoundedCache<string, Oidc>(maximumCachedClients)
  const cachedClient = (key: string, create: () => Oidc) => {
    const client = clients.get(key) ?? create()
    clients.set(key, client)
    return client
  }
  const providerSettingsOf = (preset: SsoPreset, scope: SignInScope) => ({
    redirectUri,
    emailOf: (claims: Record<string, unknown>) => ssoEmailOf(preset, claims, scope),
    subjectOf: (claims: Record<string, unknown>) => ssoSubjectOf(preset, claims),
    canBindByEmailOf: (claims: Record<string, unknown>) => ssoCanBindByEmail(preset, claims),
  })
  const accountClientOf = (provider: AccountProvider) => {
    const app = sso.instanceApps?.[provider]
    if (!app) throw new Error(`No ${provider} app is configured for accounts`)
    return cachedClient(`account ${provider}`, () =>
      createOidc({
        ...providerSettingsOf(provider, 'account'),
        issuer: accountIssuerOf(provider, sso.instanceApps ?? {}, sso.microsoftLoginOrigin),
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        isIssuerPerTenant: provider === 'microsoft',
      }),
    )
  }
  const workspaceClientOf = async (provider: Omit<SsoProvider, 'workspaceId'>) => {
    const instanceApp = provider.usesInstanceApp ? instanceAppFor(sso.instanceApps ?? {}, provider.preset) : undefined
    if (!instanceApp && !sso.secretBox) throw new Error('SPYRIA_SECRETS_KEY is required in sso mode')
    const clientSecret = instanceApp?.clientSecret ?? (await sso.secretBox?.open(provider.encryptedClientSecret))
    return cachedClient(`workspace ${provider.issuer} ${provider.clientId} ${provider.encryptedClientSecret}`, () =>
      createOidc({
        ...providerSettingsOf(provider.preset, 'workspace'),
        issuer: provider.issuer,
        clientId: instanceApp?.clientId ?? provider.clientId,
        clientSecret,
      }),
    )
  }
  const redirectToProvider = async (context: Context, client: Oidc, loginContext: LoginContext, loginHint?: string) => {
    const { url, login } = await client.authorizationUrl(loginHint || undefined)
    await setSignedCookie(context, loginCookie, JSON.stringify({ ...login, ...loginContext }), tokenSecret, {
      ...sessionCookieOptions(appOrigin),
      path: '/auth/callback',
      maxAge: loginCookieSeconds,
    })
    return context.redirect(url)
  }
  const popup = (context: Context, result: PopupResult, status: 200 | 400 | 401 | 403 | 404 = 200) =>
    context.html(
      `<!doctype html><meta charset="utf-8"><title>Signing in to Spyria</title><script>window.opener?.postMessage(${JSON.stringify(result).replaceAll('<', '\\u003c')}, ${JSON.stringify(appOrigin)});window.opener ? setTimeout(close, ${popupSelfCloseMilliseconds}) : close()</script>`,
      status,
    )
  const refusedPopup = (context: Context, error: Error) =>
    popup(context, { status: 'refused', message: error.message }, 403)
  const completeSignIn = async (
    context: Context,
    scope: ReturnType<typeof scopeOf>,
    {
      userId,
      email,
      workspaceId,
      providerWorkspaceId,
    }: { userId?: string; email: string; workspaceId?: string; providerWorkspaceId: string | null },
  ) => {
    const opened =
      userId === undefined
        ? []
        : await openSessions(scope.database, userId, workspaceId, providerWorkspaceId, userAgentOf(context))
    for (const session of opened) setSessionCookie(context, appOrigin, session)
    if (opened.length > 0) return popup(context, { status: 'signed_in' })
    if (
      workspaceId === undefined &&
      providerWorkspaceId !== null &&
      (await claimsDomainOf(scope.database, providerWorkspaceId, email))
    )
      return refusedPopup(context, new ClaimedDomainNotInvited(domainOfEmail(email)))
    if (userId === undefined || providerWorkspaceId !== null || workspaceId !== undefined)
      return popup(context, { status: 'not_invited', email }, 403)
    await setSignedCookie(
      context,
      accountCookie,
      JSON.stringify({ userId, expiresAt: Date.now() + accountCookieSeconds * 1000 }),
      tokenSecret,
      {
        ...sessionCookieOptions(appOrigin),
        path: '/auth/workspaces',
        maxAge: accountCookieSeconds,
      },
    )
    return popup(context, { status: 'no_workspace' })
  }
  const signInProvidersFor = async (scopedDatabase: Database, email: string): Promise<SignInProvider[]> => {
    const workspaceProviders = await workspaceProvidersForEmail(scopedDatabase, email)
    const isClaimed = workspaceProviders.some(({ isClaiming }) => isClaiming)
    return [
      ...(isClaimed ? [] : accountProviders).map((provider) => ({
        id: provider,
        kind: provider,
        isWorkspaceSso: false,
      })),
      ...workspaceProviders.map(({ preset }, index) => ({
        id: `${workspaceProviderPrefix}${index}`,
        kind: preset,
        isWorkspaceSso: true,
      })),
    ]
  }
  const sessionIdByWorkspaceOf = (context: Context) =>
    Object.entries(getCookie(context)).flatMap(([name, sessionId]) =>
      name.startsWith(sessionCookiePrefix)
        ? [[name.slice(sessionCookiePrefix.length), sessionId] as [string, string]]
        : [],
    )
  const signedInEmailOf = async (context: Context, scopedDatabase: Database) => {
    const [session] = await findLiveSessions(scopedDatabase, sessionIdByWorkspaceOf(context))
    return session ? await emailOfUser(scopedDatabase, session.userId) : ''
  }
  const lastAccountProviderOf = (context: Context) =>
    accountProviders.find((provider) => provider === getCookie(context, accountProviderCookie)) ?? accountProviders[0]
  const redirectToAccountProvider = (
    context: Context,
    provider: AccountProvider,
    loginContext: LoginContext,
    loginHint?: string,
  ) => {
    setCookie(context, accountProviderCookie, provider, {
      ...sessionCookieOptions(appOrigin),
      path: '/auth/login',
      maxAge: accountProviderCookieSeconds,
    })
    return redirectToProvider(
      context,
      accountClientOf(provider),
      { ...loginContext, accountProvider: provider },
      loginHint,
    )
  }
  const signInThroughProviderOf = async (
    context: Context,
    scopedDatabase: Database,
    { workspaceId, email, providerId }: { workspaceId?: string; email: string; providerId: string },
  ) => {
    const workspaceProvider = async (providerWorkspaceId: string | undefined, loginHint = email) => {
      const provider = providerWorkspaceId && (await workspaceProviderOf(scopedDatabase, providerWorkspaceId))
      return provider
        ? redirectToProvider(
            context,
            await workspaceClientOf(provider),
            { workspaceId, providerWorkspaceId },
            loginHint,
          )
        : undefined
    }
    if (workspaceId) {
      const accountProvider = lastAccountProviderOf(context)
      const knownEmail = email || (await signedInEmailOf(context, scopedDatabase))
      const claimingProvider = knownEmail
        ? (await workspaceProvidersForEmail(scopedDatabase, knownEmail)).find(({ isClaiming }) => isClaiming)
        : undefined
      return (
        (await workspaceProvider(workspaceId)) ??
        (await workspaceProvider(claimingProvider?.workspaceId, knownEmail)) ??
        (accountProvider && redirectToAccountProvider(context, accountProvider, { workspaceId }))
      )
    }
    if (providerId.startsWith(workspaceProviderPrefix)) {
      const index = Number(providerId.slice(workspaceProviderPrefix.length))
      return workspaceProvider((await workspaceProvidersForEmail(scopedDatabase, email))[index]?.workspaceId)
    }
    const accountProvider = accountProviders.find((provider) => provider === providerId)
    return accountProvider && redirectToAccountProvider(context, accountProvider, {}, email)
  }
  const clientOfLogin = async (scopedDatabase: Database, loginContext: LoginContext) => {
    const { firstWorkspace, pendingSso, providerWorkspaceId, accountProvider } = loginContext
    if (authMode === 'dex') return { client: oidc }
    if (firstWorkspace)
      return {
        client: firstWorkspace.provider
          ? await workspaceClientOf(firstWorkspace.provider)
          : accountClientOf(firstWorkspace.accountProvider),
      }
    if (pendingSso) return { client: await workspaceClientOf(pendingSso.provider) }
    if (providerWorkspaceId) {
      const provider = await workspaceProviderOf(scopedDatabase, providerWorkspaceId)
      return { client: provider && (await workspaceClientOf(provider)), provider }
    }
    return { client: accountProvider && accountClientOf(accountProvider) }
  }
  const setupTokenLimited = rateLimited('setupToken')
  const setupLinkLimited: MiddlewareHandler = (context, next) =>
    context.req.query('setup') === undefined ? next() : setupTokenLimited(context, next)
  const sessionIdOf = (context: Context, workspaceId: string) =>
    getCookie(context, `${sessionCookiePrefix}${workspaceId}`) ?? ''
  const isSameOrigin = (context: Context) => context.req.header('origin') === appOrigin
  const isStartedHere = (context: Context) =>
    ['same-origin', 'none', undefined].includes(context.req.header('sec-fetch-site'))
  const asMember = async (
    context: Context,
    act: (
      member: Extract<Authentication, { status: 200 }> & { scope: ReturnType<typeof scopeOf> },
    ) => Promise<Response>,
  ) => {
    const authentication = await authenticate(context.req.header('authorization'))
    if (authentication.status !== 200)
      return context.json({ error: errorByStatus[authentication.status] }, authentication.status)
    return act({ ...authentication, scope: scopeOf(context, authentication.databaseName) })
  }

  return new Hono()
    .use('/:action{renew|logout|workspaces}', async (context, next) => {
      if (!isSameOrigin(context) || context.req.header('x-spyria-csrf') !== '1')
        return context.json({ error: 'forbidden' }, 403)
      await next()
    })
    .get('/mode', setupLinkLimited, async (context) => {
      const isBeingSetUp = authMode === 'sso' && (await hasNoWorkspace(scopeOf(context).database.$client))
      return context.json({
        authMode,
        isBeingSetUp,
        canCreateWorkspace: isBeingSetUp && isSetupToken(context.req.query('setup')),
        accountProviders,
        callbackOrigin: new URL(redirectUri).origin,
        instanceApps: authMode === 'sso' ? instanceAppPresets.filter((preset) => sso.instanceApps?.[preset]) : [],
      })
    })
    .get('/providers', rateLimited('emailRouting'), async (context) => {
      const email = normalizedEmail(context.req.query('email') ?? '')
      if (authMode !== 'sso') return context.json({ providers: [] })
      return context.json({ providers: await signInProvidersFor(scopeOf(context).database, email) })
    })
    .post('/first-workspace', rateLimited('workspaceCreation'), async (context) => {
      if (authMode !== 'sso' || !isSameOrigin(context)) return context.json({ error: 'forbidden' }, 403)
      const form = await context.req.parseBody()
      if (!isSetupToken(form.setupToken))
        return popup(context, { status: 'refused', message: setupLinkNeededNotice }, 403)
      const firstWorkspace = await prepareFirstWorkspace(scopeOf(context).database, sso, form, accountProviders).catch(
        domainErrorOnly,
      )
      if (firstWorkspace instanceof Error)
        return popup(context, { status: 'refused', message: firstWorkspace.message }, 400)
      const client = firstWorkspace.provider
        ? await workspaceClientOf(firstWorkspace.provider)
        : accountClientOf(firstWorkspace.accountProvider)
      return redirectToProvider(context, client, { firstWorkspace })
    })
    .post('/workspaces', rateLimited('workspaceCreation'), async (context) => {
      const scope = scopeOf(context)
      const signedAccount = await getSignedCookie(context, tokenSecret, accountCookie)
      const account = signedAccount ? (JSON.parse(signedAccount) as { userId?: string; expiresAt?: number }) : {}
      const userId = (account.expiresAt ?? 0) > Date.now() ? account.userId : undefined
      if (!userId) return context.json({ error: 'unauthorized' }, 401)
      const body = await context.req.json().catch(() => null)
      const created = await createWorkspaceOfAccount(scope.database, userId, body?.name).catch(domainErrorOnly)
      if (created instanceof DomainError) return context.json({ error: created.code, message: created.message }, 400)
      const [session] = await openSessions(scope.database, userId, created, null, userAgentOf(context))
      if (!session) return context.json({ error: 'forbidden' }, 403)
      setSessionCookie(context, appOrigin, session)
      deleteCookie(context, accountCookie, { path: '/auth/workspaces' })
      return context.json(await scope.issue(session))
    })
    .post('/workspace-sso', rateLimited('ssoChanges'), async (context) => {
      if (authMode !== 'sso' || !isSameOrigin(context)) return context.json({ error: 'forbidden' }, 403)
      const form = await context.req.parseBody()
      const workspaceId = typeof form.workspaceId === 'string' ? form.workspaceId : ''
      const { database: scopedDatabase } = scopeOf(context)
      const [session] = await findLiveSessions(scopedDatabase, [[workspaceId, sessionIdOf(context, workspaceId)]])
      if (!session) return popup(context, { status: 'failed' }, 401)
      const pendingSso = await prepareSsoSettings(scopedDatabase, sso, session, form).catch(domainErrorOnly)
      if (pendingSso instanceof Error) return popup(context, { status: 'refused', message: pendingSso.message }, 400)
      return redirectToProvider(context, await workspaceClientOf(pendingSso.provider), { pendingSso }, pendingSso.email)
    })
    .get('/login', rateLimited('emailRouting'), async (context) => {
      if (!isStartedHere(context)) return context.json({ error: 'forbidden' }, 403)
      const scope = scopeOf(context)
      const workspaceId = context.req.query('workspace')
      if (scope.testUserId)
        return completeSignIn(context, scope, {
          userId: scope.testUserId,
          email: '',
          workspaceId,
          providerWorkspaceId: null,
        })
      if (authMode === 'dex') return redirectToProvider(context, oidc, { workspaceId })
      if (await hasNoWorkspace(scope.database.$client))
        return popup(context, { status: 'refused', message: setupLinkNeededNotice }, 403)
      const redirected = await signInThroughProviderOf(context, scope.database, {
        workspaceId,
        email: normalizedEmail(context.req.query('email') ?? ''),
        providerId: context.req.query('provider') ?? '',
      })
      return redirected ?? popup(context, { status: 'failed' }, 404)
    })
    .get('/callback', rateLimited('signInCallback'), async (context) => {
      const signedLogin = await getSignedCookie(context, tokenSecret, loginCookie)
      deleteCookie(context, loginCookie, { path: '/auth/callback' })
      const { workspaceId, providerWorkspaceId, accountProvider, firstWorkspace, pendingSso, ...login } = signedLogin
        ? (JSON.parse(signedLogin) as LoginContext & { state: string; nonce: string; codeVerifier: string })
        : ({} as LoginContext & { state: string; nonce: string; codeVerifier: string })
      const scope = scopeOf(context)
      const { client, provider } = signedLogin
        ? await clientOfLogin(scope.database, { firstWorkspace, pendingSso, providerWorkspaceId, accountProvider })
        : { client: undefined, provider: undefined }
      const identity: VerifiedIdentity | Error | undefined = client
        ? await client
            .verifiedIdentityOf(new URL(context.req.url), login)
            .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
        : undefined
      if (identity instanceof EmailRefused && identity.refusal === 'unconfirmed')
        return refusedPopup(context, new EmailNotConfirmed())
      if (identity === undefined || identity instanceof Error) return popup(context, { status: 'failed' }, 400)
      const signedIn = await (firstWorkspace
        ? createFirstWorkspace(scope.database, firstWorkspace, identity, sso).then((created) => ({
            ...created,
            email: identity.email,
            providerWorkspaceId: firstWorkspace.provider ? created.workspaceId : null,
          }))
        : pendingSso
          ? confirmSsoSettings(scope.database, pendingSso, identity).then((confirmed) => ({
              ...confirmed,
              email: identity.email,
              providerWorkspaceId: confirmed.workspaceId,
            }))
          : provider
            ? signInThroughWorkspace(
                scope.database,
                {
                  workspaceId: provider.workspaceId,
                  issuer: provider.issuer,
                  currentSubjectPattern: provider.preset === 'microsoft' ? entraObjectIdPattern : undefined,
                },
                identity,
              ).then((user) => ({ ...user, workspaceId, providerWorkspaceId: provider.workspaceId }))
            : signInWithAccount(scope.database, identity).then((user) => ({
                ...user,
                workspaceId,
                providerWorkspaceId: null,
              }))
      ).catch(domainErrorOnly)
      if (signedIn instanceof Error) return refusedPopup(context, signedIn)
      return completeSignIn(context, scope, signedIn)
    })
    .get('/sessions', async (context) => {
      const scope = scopeOf(context)
      const liveSessions = await findLiveSessions(scope.database, sessionIdByWorkspaceOf(context))
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
      deleteCookie(context, `${sessionCookiePrefix}${workspaceId}`, { path: '/auth' })
      return context.body(null, 204)
    })
    .post('/sessions', (context) =>
      asMember(context, async ({ context: member, sessionId, scope }) => {
        if (member.signedInThrough === 'workspace sso') return context.json({ error: 'forbidden' }, 403)
        const workspaceId = await workspaceIdOfBody(context)
        const signIn = await signInOf(scope.database, { ...member, sessionId })
        if (!signIn) return context.json({ error: 'unauthorized' }, 401)
        if (await isSignedOutSince(scope.database, workspaceId, member.userId, signIn.signedInAt))
          return context.json({ error: 'forbidden' }, 403)
        const [session] = await openSessions(
          scope.database,
          member.userId,
          workspaceId,
          signIn.providerWorkspaceId,
          userAgentOf(context),
          signIn.signedInAt,
        )
        if (!session) return context.json({ error: 'forbidden' }, 403)
        setSessionCookie(context, appOrigin, session)
        return context.json(await scope.issue(session))
      }),
    )
    .get('/active-sessions', (context) =>
      asMember(context, async ({ context: { workspaceId, userId }, sessionId: currentSessionId, scope }) => {
        const sessions = await findMemberSessions(scope.database, workspaceId, userId)
        return context.json({
          sessions: sessions.map(({ sessionId, userAgent, signedInAt }) => ({
            userAgent,
            signedInAt,
            isCurrent: sessionId === currentSessionId,
          })),
        })
      }),
    )
    .post('/sign-out-everywhere', (context) =>
      asMember(context, async ({ context: { workspaceId, userId }, scope }) => {
        await signOutMemberEverywhere(scope.database, workspaceId, userId)
        deleteCookie(context, `${sessionCookiePrefix}${workspaceId}`, { path: '/auth' })
        return context.body(null, 204)
      }),
    )
}
