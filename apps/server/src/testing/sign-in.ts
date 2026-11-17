import { expect } from 'bun:test'
import type { Database } from '@spyria/db/postgres'
import { workspacePermissions } from '@spyria/kernel'
import type { JWTPayload } from 'jose'
import { createSecretBox, type SecretsKeyring } from '../auth/secret-box.ts'
import type { FakeIdp } from './fake-idp.ts'
import { alice } from './testing.ts'

type RequestingApp = { request: (path: string, init?: RequestInit) => Response | Promise<Response> }

export const cookieHeaderOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0] ?? '')
    .filter((cookie) => !cookie.endsWith('='))
    .join('; ')

let codeCount = 0

export const fakeIdpSignInOf = ({
  database,
  secretsKeyring,
  app,
}: {
  database: Database
  secretsKeyring: SecretsKeyring
  app: RequestingApp
}) => {
  const addWorkspace = async (workspaceId: string, adminId: string = alice, memberIds: string[] = []) => {
    await database.$client`
      insert into workspaces (workspace_id, name, created_by, created_at) values (${workspaceId}, ${workspaceId}, ${adminId}, now())`
    await database.$client`
      insert into workspace_roles (workspace_id, id, name, built_in)
      values (${workspaceId}, 'admin', 'Admin', true), (${workspaceId}, 'member', 'Member', true)`
    await database.$client`
      insert into workspace_role_permissions (workspace_id, role_id, permission)
      select ${workspaceId}, 'admin', unnest(${database.$client.array([...workspacePermissions])}::text[])`
    await database.$client`
      insert into memberships (workspace_id, user_id, role, display_name) values (${workspaceId}, ${adminId}, 'admin', 'Admin')`
    for (const memberId of memberIds)
      await database.$client`
        insert into memberships (workspace_id, user_id, role, display_name)
        values (${workspaceId}, ${memberId}, 'member', ${memberId})`
  }
  const enforceSso = async (workspaceId: string, idp: FakeIdp, { preset = 'oidc', issuer = idp.issuer } = {}) => {
    const clientId = `spyria-${workspaceId}`
    idp.clientSecrets[clientId] = `${workspaceId}-secret`
    const encryptedClientSecret = await createSecretBox(secretsKeyring).seal(`${workspaceId}-secret`)
    await database.$client`
      insert into workspace_sso (workspace_id, preset, issuer, client_id, encrypted_client_secret, updated_at)
      values (${workspaceId}, ${preset}, ${issuer}, ${clientId}, ${encryptedClientSecret}, now())`
  }
  const sessionsOf = async (cookie: string, server: RequestingApp) =>
    (await (await server.request('/auth/sessions', { headers: { cookie } })).json()) as {
      userId?: string
      sessions: { workspaceId: string; token: string }[]
    }
  const callbackAfter = async (idp: FakeIdp, started: Response, claims: JWTPayload, server = app) => {
    const location = new URL(started.headers.get('location') ?? '')
    expect(location.origin).toBe(idp.origin)
    const code = `code-${++codeCount}`
    idp.claimsByCode.set(code, { nonce: location.searchParams.get('nonce') ?? '', ...claims })
    const response = await server.request(`/auth/callback?code=${code}&state=${location.searchParams.get('state')}`, {
      headers: { cookie: cookieHeaderOf(started) },
    })
    const cookie = cookieHeaderOf(response)
    return {
      status: response.status,
      page: await response.text(),
      cookie,
      authorizationEndpoint: location.origin + location.pathname,
      clientId: location.searchParams.get('client_id'),
      loginHint: location.searchParams.get('login_hint'),
      ...(await sessionsOf(cookie, server)),
    }
  }
  const signInThrough = async (idp: FakeIdp, loginQuery: string, claims: JWTPayload, server = app) =>
    callbackAfter(idp, await server.request(`/auth/login?${loginQuery}`), claims, server)
  return { addWorkspace, enforceSso, callbackAfter, signInThrough }
}
