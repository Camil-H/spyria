import { afterAll, expect, test } from 'bun:test'
import { createTestDatabase, databaseDropTimeoutMilliseconds } from '@spyria/db/testing'
import { createApp } from '../app.ts'
import { createFirstWorkspace } from '../auth/sso.ts'
import { runOperator } from '../testing/operator.ts'
import { testAuthSettings } from '../testing/testing.ts'
import { serverWebSocket } from './gateway.ts'

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

const claimWith = (code: string) =>
  new Promise<{ token?: string; closeCode?: number; reason?: string }>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/host`)
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

  const { workspaceId } = await createFirstWorkspace(
    database,
    {
      workspaceName: 'Garage',
      joinBy: 'invited_address',
      domain: null,
      provider: {
        preset: 'oidc',
        issuer: 'https://idp.install-host.test',
        clientId: 'spyria',
        usesInstanceApp: false,
        encryptedClientSecret: 'sealed',
      },
    },
    { email: 'owner@gmail.com', subject: 'owner-subject' },
    { installHostToken },
  )
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

test('without an install host token the first workspace comes with no host', async () => {
  const other = await createTestDatabase()
  try {
    await other.database.$client`truncate workspaces, users cascade`
    await createFirstWorkspace(
      other.database,
      {
        workspaceName: 'Plain',
        joinBy: 'domain',
        domain: 'plain.test',
        provider: {
          preset: 'oidc',
          issuer: 'https://idp.plain.test',
          clientId: 'spyria',
          usesInstanceApp: false,
          encryptedClientSecret: 'sealed',
        },
      },
      { email: 'owner@plain.test', subject: 'owner-subject' },
    )
    expect(await other.database.$client`select 1 from runtime_hosts`).toHaveLength(0)
  } finally {
    await other.drop()
  }
})
