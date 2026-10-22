import { afterAll, expect, setSystemTime, test } from 'bun:test'
import { createTestDatabase, databaseDropTimeoutMilliseconds } from '@spyria/db/testing'
import { createApp } from '../app.ts'
import { createSecretBox } from '../auth/secret-box.ts'
import {
  fakeGitHubAppId,
  fakeGitHubAppSlug,
  fakeGitHubClientId,
  fakeGitHubClientSecret,
  startFakeGitHub,
} from '../testing/fake-github.ts'
import {
  acme,
  alice,
  bob,
  globex,
  sessionTokenOf,
  testAuthSettings,
  testSecretsKey,
  workspaceEventsOf,
} from '../testing/testing.ts'
import { createGitHubApi } from './github-api.ts'

const testDatabase = await createTestDatabase()
const { database } = testDatabase
const fakeGitHub = startFakeGitHub()
const secretBox = createSecretBox(testSecretsKey)
const app = createApp({
  database,
  ...testAuthSettings,
  github: { api: createGitHubApi(fakeGitHub.urls), secretBox },
})
const { appOrigin } = testAuthSettings
afterAll(async () => {
  await fakeGitHub.stop()
  await testDatabase.drop()
}, databaseDropTimeoutMilliseconds)

const startCreation = async (workspaceId: string, userId: string, organization = '') => {
  const response = await app.request('/api/github-settings/manifest', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await sessionTokenOf(database, workspaceId, userId)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ organization }),
  })
  return { status: response.status, body: await response.json() }
}
const createOnGitHub = async ({ formAction, manifest }: { formAction: string; manifest: string }) => {
  const page = await (await fetch(formAction, { method: 'POST', body: new URLSearchParams({ manifest }) })).text()
  const parameters = Object.fromEntries(
    [...page.matchAll(/name="(code|state)" value="([^"]*)"/g)].map(([, name, value]) => [name, value]),
  )
  return `/auth/github/app-created?${new URLSearchParams(parameters)}`
}
const returnFromGitHub = async (path: string) => {
  const response = await app.request(path)
  return { status: response.status, location: response.headers.get('location'), page: await response.text() }
}
const appRowOf = async (workspaceId: string) =>
  (await database.$client`select * from github_apps where workspace_id = ${workspaceId}`)[0] as
    | Record<string, string>
    | undefined
const invalidLink = 'This link is invalid or expired: create the GitHub App again from Spyria'

test('the manifest carries Spyria permissions, events and URLs from the origin, under a unique-ish name, posted to the account or organization page; only Connect GitHub may start it', async () => {
  expect(await startCreation(acme, bob)).toMatchObject({
    status: 403,
    body: { error: 'missing_workspace_permission', message: 'Your workspace role does not allow this: Connect GitHub' },
  })
  expect(await startCreation(acme, alice, 'acme/../x')).toMatchObject({
    status: 400,
    body: { message: 'Enter the organization login as it appears in its GitHub URL' },
  })
  const personal = (await startCreation(acme, alice)).body
  expect(personal.formAction).toStartWith(`${fakeGitHub.urls.webUrl}/settings/apps/new?state=`)
  const manifest = JSON.parse(personal.manifest)
  expect(manifest.name).toMatch(/^Spyria Acme [0-9a-f]{4}$/)
  expect(manifest).toEqual({
    name: manifest.name,
    url: appOrigin,
    hook_attributes: { url: `${appOrigin}/api/github/webhooks`, active: true },
    redirect_url: `${appOrigin}/auth/github/app-created`,
    callback_urls: [`${appOrigin}/auth/github/callback`],
    setup_url: `${appOrigin}/w/${acme}/settings/github`,
    setup_on_update: true,
    request_oauth_on_install: false,
    public: false,
    default_permissions: { contents: 'write', pull_requests: 'write', checks: 'read', metadata: 'read' },
    default_events: [
      'pull_request',
      'pull_request_review',
      'pull_request_review_comment',
      'pull_request_review_thread',
      'check_suite',
      'check_run',
    ],
  })
  const organization = (await startCreation(acme, alice, 'acme-corp')).body
  expect(organization.formAction).toStartWith(
    `${fakeGitHub.urls.webUrl}/organizations/acme-corp/settings/apps/new?state=`,
  )
  expect(JSON.parse(organization.manifest).name).not.toBe(manifest.name)
})

test('returning from GitHub with a forged, tampered (another workspace) or expired state, or as a member who lost Connect GitHub, stores nothing and leaves the code unused', async () => {
  const returnPath = await createOnGitHub((await startCreation(acme, alice)).body)
  const { code = '', state = '' } = Object.fromEntries(new URL(returnPath, appOrigin).searchParams)
  const [payload, signature] = state.split('.')
  const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString())
  const otherWorkspace = Buffer.from(JSON.stringify({ ...claims, workspaceId: globex })).toString('base64url')
  for (const forged of ['x.y', `${otherWorkspace}.${signature}`])
    expect(await returnFromGitHub(`/auth/github/app-created?${new URLSearchParams({ code, state: forged })}`)).toEqual({
      status: 400,
      location: null,
      page: expect.stringContaining(invalidLink),
    })

  await database.$client`update memberships set role = 'member' where workspace_id = ${acme} and user_id = ${alice}`
  try {
    expect(await returnFromGitHub(returnPath)).toMatchObject({
      status: 400,
      page: expect.stringContaining('Your workspace role does not allow this: Connect GitHub'),
    })
  } finally {
    await database.$client`update memberships set role = 'admin' where workspace_id = ${acme} and user_id = ${alice}`
  }
  setSystemTime(new Date(Date.now() + 61 * 60 * 1000))
  try {
    expect(await returnFromGitHub(returnPath)).toMatchObject({
      status: 400,
      page: expect.stringContaining(invalidLink),
    })
  } finally {
    setSystemTime()
  }
  expect(await appRowOf(acme)).toBeUndefined()
  expect(await appRowOf(globex)).toBeUndefined()
  expect(fakeGitHub.apiRequests.filter((request) => request.includes('/app-manifests/'))).toEqual([])
})

test('the conversion stores the created App sealed like the manual form, records github.configured, then sends the admin to the install page; the code works once and a member connection state is refused', async () => {
  const returnPath = await createOnGitHub((await startCreation(acme, alice, 'acme-corp')).body)
  const returned = await returnFromGitHub(returnPath)
  expect(returned).toMatchObject({
    status: 302,
    location: `${fakeGitHub.urls.webUrl}/apps/${fakeGitHubAppSlug}/installations/new`,
  })
  const created = fakeGitHub.appCreations.at(-1)
  expect(created?.owner).toBe('acme-corp')
  const row = await appRowOf(acme)
  expect(row).toMatchObject({ app_id: fakeGitHubAppId, client_id: fakeGitHubClientId })
  for (const secret of [fakeGitHubClientSecret, created?.webhookSecret ?? '', 'PRIVATE KEY'])
    expect(JSON.stringify(row)).not.toContain(secret)
  expect(await secretBox.open(row?.encrypted_client_secret ?? '')).toBe(fakeGitHubClientSecret)
  expect(await secretBox.open(row?.encrypted_webhook_secret ?? '')).toBe(created?.webhookSecret ?? '')
  expect(await secretBox.open(row?.encrypted_private_key ?? '')).toBe(fakeGitHub.appPrivateKey.trim())
  expect(
    (await workspaceEventsOf(database))
      .filter(({ type }) => type.startsWith('github.'))
      .map(({ type, actorId, payload }) => ({ type, actorId, payload })),
  ).toEqual([
    { type: 'github.configured', actorId: alice, payload: { appId: fakeGitHubAppId, clientId: fakeGitHubClientId } },
  ])
  expect(await returnFromGitHub(returnPath)).toMatchObject({
    status: 400,
    page: expect.stringContaining('GitHub refused the request: 404'),
  })
  const connection = await app.request('/api/github/connection/connect', {
    method: 'POST',
    headers: { authorization: `Bearer ${await sessionTokenOf(database, acme, alice)}` },
  })
  const connectionState = new URL((await connection.json()).authorizeUrl).searchParams.get('state') ?? ''
  const { code = '' } = Object.fromEntries(new URL(returnPath, appOrigin).searchParams)
  expect(
    await returnFromGitHub(`/auth/github/app-created?${new URLSearchParams({ code, state: connectionState })}`),
  ).toMatchObject({ status: 400, page: expect.stringContaining(invalidLink) })
  const settings = await app.request('/api/github-settings', {
    headers: { authorization: `Bearer ${await sessionTokenOf(database, acme, alice)}` },
  })
  expect((await settings.json()).settings.repositories.map(({ fullName }: { fullName: string }) => fullName)).toEqual([
    'acme/app',
    'acme/docs',
  ])
})
