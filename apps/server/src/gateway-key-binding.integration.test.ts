import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import {
  acme,
  addLlmKey,
  alice,
  asMember,
  bob,
  createFakeHosts,
  lee,
  openSharedTestApp,
  runtimeTurn,
  virtualKeyOf,
} from './testing/testing.ts'

setDefaultTimeout(30_000)
const { database, port, fakeLlmCalls } = await openSharedTestApp()
const { fakeHost, disconnectFakeHosts } = createFakeHosts({ port, database })
afterEach(() => disconnectFakeHosts())

const providerKeyIdsOf = async (userId: string) =>
  (await virtualKeyOf(userId)).provider_configs.flatMap((config) => config.keys.map((key) => key.key_id))

test('changing a member’s tool grants keeps their provider key on their virtual key, so their model calls still run', async () => {
  const bobSecret = `fake-key-bob-${crypto.randomUUID()}`
  await addLlmKey(bob, 'Mistral', bobSecret)
  const keyIdsBefore = await providerKeyIdsOf(bob)
  expect(keyIdsBefore).toHaveLength(1)

  const readOnly = await asMember(alice, 'POST', '/api/workspace-connections/connection-crm/access', {
    roleId: 'member',
    level: 'read',
    toolChanges: {},
  })
  expect(readOnly.status).toBe(200)
  expect(
    (await virtualKeyOf(bob)).mcp_configs.find((config) => config.mcp_client.name === 'crm')?.tools_to_execute,
  ).toEqual(['lookup'])
  expect(await providerKeyIdsOf(bob)).toEqual(keyIdsBefore)

  const host = await fakeHost('Key binding host')
  const { token } = await runtimeTurn(host, bob)
  const callsBefore = fakeLlmCalls.length
  const answer = await host.modelCall({
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mistral/codestral-latest',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
  expect(answer).toMatchObject({ status: 200, ended: 'gw_end' })
  expect(fakeLlmCalls.slice(callsBefore).map((call) => call.authorization)).toContain(`Bearer ${bobSecret}`)
})

test('a member key the gateway created but Spyria never recorded, as when the server stops in between, is bound again by its stored name instead of created twice', async () => {
  await addLlmKey(lee, 'Mistral')
  const created = await virtualKeyOf(lee)
  const [{ virtual_key_name: storedName } = {}] = await database.$client`
    select virtual_key_name from member_gateway_keys where workspace_id = ${acme} and user_id = ${lee}`
  expect(created.name).toBe(storedName)
  await database.$client`
    update member_gateway_keys set virtual_key_id = null where workspace_id = ${acme} and user_id = ${lee}`

  await addLlmKey(lee, 'Mistral')
  const bound = await virtualKeyOf(lee)
  expect(bound.id).toBe(created.id)
  expect(bound.provider_configs.flatMap((config) => config.keys)).toHaveLength(2)
})
