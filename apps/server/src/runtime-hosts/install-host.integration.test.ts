import { afterAll, expect, test } from 'bun:test'
import { createTestDatabase, databaseDropTimeoutMilliseconds } from '@spyria/db/testing'
import { Name } from '@spyria/workspace/server'
import { createApp } from '../app.ts'
import { createFirstWorkspace, hasNoWorkspace } from '../auth/sso.ts'
import { runOperator } from '../testing/operator.ts'
import { testAuthSettings, testSecretsKeyring } from '../testing/testing.ts'
import { createRuntimeHostGateway, serverWebSocket } from './gateway.ts'

const instance = await createTestDatabase()
const { database } = instance
await database.$client`truncate workspaces, users cascade`
const installHostToken = 'ABCDEFGHJKMNPQRS'
const app = createApp({ database, ...testAuthSettings, authMode: 'sso', installHostToken })
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket: serverWebSocket })
afterAll(async () => {
  await server.stop(true)
  await instance.drop()
}, databaseDropTimeoutMilliseconds)

const claimWith = (code: string, port = server.port) =>
  new Promise<{ token?: string; closeCode?: number; reason?: string }>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/host`)
    let reason: string | undefined
    socket.onopen = () => socket.send(JSON.stringify({ type: 'claim', code }))
    socket.onmessage = (message) => {
      const frame = JSON.parse(String(message.data))
      if (frame.type === 'token') {
        resolve({ token: frame.token })
        socket.close()
      }
      if (frame.type === 'refused') reason = frame.reason
    }
    socket.onclose = (event) => resolve({ closeCode: event.code, reason: reason ?? event.reason })
  })

const createGarageWorkspace = (garageDatabase: typeof database) =>
  createFirstWorkspace(
    garageDatabase,
    {
      workspaceName: Name('Garage'),
      provider: {
        preset: 'oidc',
        issuer: 'https://idp.install-host.test',
        clientId: 'spyria',
        usesInstanceApp: false,
        encryptedClientSecret: 'sealed',
      },
    },
    {
      email: 'owner@gmail.com',
      issuer: 'https://idp.install-host.test',
      subject: 'owner-subject',
      canBindByEmail: true,
    },
    { installHostToken },
  )

const setupToken = 's'.repeat(48)
const operatorSays = (command: string) =>
  runOperator(instance.name, [command], { SPYRIA_APP_ORIGIN: 'https://spyria.example', SPYRIA_SETUP_TOKEN: setupToken })

test('the machine host waits with the install token until the first workspace exists, then pairs with it once as a workspace host, while the operator says whether a workspace exists and prints the setup link only until one does', async () => {
  expect(await claimWith(installHostToken)).toEqual({
    closeCode: 1013,
    reason: 'Waiting for the first workspace of this Spyria',
  })
  expect(await claimWith('ZZZZZZZZZZZZZZZZ')).toMatchObject({ closeCode: 4001, reason: 'This code is not valid' })
  expect(await operatorSays('has-workspace')).toEqual({ exitCode: 0, stdout: 'no\n', stderr: '' })
  expect(await operatorSays('setup-link')).toEqual({
    exitCode: 0,
    stdout: `https://spyria.example/?setup=${setupToken}\n`,
    stderr: '',
  })

  const { workspaceId } = await createGarageWorkspace(database)
  expect(await operatorSays('has-workspace')).toEqual({ exitCode: 0, stdout: 'yes\n', stderr: '' })
  expect(await operatorSays('setup-link')).toEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'A workspace already exists: the setup link is spent\n',
  })
  const paired = await claimWith(installHostToken)
  expect(paired.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect([
    ...(await database.$client`select workspace_id, name, owner_id, status, token_hash is not null as has_token from runtime_hosts`),
  ]).toEqual([{ workspace_id: workspaceId, name: 'This machine', owner_id: null, status: 'offline', has_token: true }])
  expect(await claimWith(installHostToken)).toMatchObject({ closeCode: 4001, reason: 'This code was already used' })
})

test('the machine host pairs when the first workspace is created between its refused claim and the check for a workspace', async () => {
  const raced = await createTestDatabase()
  await raced.database.$client`truncate workspaces, users cascade`
  const racedApp = createApp({
    database: raced.database,
    ...testAuthSettings,
    authMode: 'sso',
    installHostToken,
    runtimeHosts: createRuntimeHostGateway({
      databases: () => [raced.database],
      secretsKeyring: testSecretsKeyring,
      awaitsFirstWorkspace: async () => {
        await createGarageWorkspace(raced.database)
        return hasNoWorkspace(raced.database.$client)
      },
    }),
  })
  const racedServer = Bun.serve({ port: 0, fetch: racedApp.fetch, websocket: serverWebSocket })
  try {
    const paired = await claimWith(installHostToken, racedServer.port)
    expect(paired.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  } finally {
    await racedServer.stop(true)
    await raced.drop()
  }
})

test('without an install host token the first workspace comes with no host', async () => {
  const other = await createTestDatabase()
  try {
    await other.database.$client`truncate workspaces, users cascade`
    await createFirstWorkspace(
      other.database,
      {
        workspaceName: Name('Plain'),
        provider: {
          preset: 'oidc',
          issuer: 'https://idp.plain.test',
          clientId: 'spyria',
          usesInstanceApp: false,
          encryptedClientSecret: 'sealed',
        },
      },
      { email: 'owner@plain.test', issuer: 'https://idp.plain.test', subject: 'owner-subject', canBindByEmail: true },
    )
    expect(await other.database.$client`select 1 from runtime_hosts`).toHaveLength(0)
  } finally {
    await other.drop()
  }
})
