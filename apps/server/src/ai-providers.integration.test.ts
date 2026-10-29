import { afterAll, afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import {
  acme,
  addLlmKey,
  aliceInAcme,
  asMember,
  bob,
  bobInAcme,
  failedWith,
  openSharedTestApp,
  runtimeTurn,
  startAgentStack,
  succeeded,
  workspaceEventsOf,
} from './testing/testing.ts'

setDefaultTimeout(40_000)
const { database, fakeLlmCalls, fakeHost } = await startAgentStack({ routing: true })
const { resultOf } = await openSharedTestApp()
await addLlmKey(bob, 'Mistral')

const setAllowList = (allowList: object | null, member = aliceInAcme) =>
  resultOf(member, 'profile.setAiProviders', { workspaceId: acme, allowList })
const relayedCallOf = async (model: string, fields: object = {}) => {
  const host = await fakeHost('Provider host')
  const { token } = await runtimeTurn(host, bob)
  const callsBefore = fakeLlmCalls.length
  const answer = await host.modelCall({
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], ...fields }),
  })
  return { status: answer.status, body: JSON.parse(answer.body), reached: fakeLlmCalls.length - callsBefore }
}

afterAll(async () => {
  await database.$client`delete from llm_credentials where user_id = ${bob}`
})

afterEach(async () => {
  await database.$client`update workspaces set ai_provider_allow_list = null`
  await database.$client`delete from workspace_events where type = 'ai_providers.changed'`
})

test('only a member allowed to manage AI providers changes the allow-list, and each change is audited in plain words', async () => {
  expect(await setAllowList(['anthropic'], bobInAcme)).toEqual(
    failedWith('Your workspace role does not allow this: Manage AI providers'),
  )
  expect(await setAllowList(['fake'])).toEqual(failedWith('fake is not a supported provider'))
  expect(await setAllowList(['mistral', 'anthropic', 'mistral'])).toEqual(succeeded)
  const [workspace] = await database.$client`select ai_provider_allow_list from workspaces where workspace_id = ${acme}`
  expect(workspace?.ai_provider_allow_list).toEqual(['anthropic', 'mistral'])
  expect((await workspaceEventsOf(database)).filter(({ type }) => type === 'ai_providers.changed')).toEqual([
    {
      type: 'ai_providers.changed',
      actorId: aliceInAcme.userId,
      payload: { allowed: ['Anthropic', 'Mistral'] },
    },
  ])
})

test('a key for a provider left out of the allow-list is refused before it reaches the gateway', async () => {
  await setAllowList(['anthropic'])
  const refused = await asMember(bob, 'POST', '/api/llm-credentials', { provider: 'OpenAI', secret: 'sk-test-1234' })
  expect(refused.status).toBe(400)
  expect(JSON.parse(refused.body)).toEqual({
    error: 'provider_not_allowed',
    message: 'OpenAI is not allowed in this workspace',
  })
})

test('the relay refuses a model of a provider the allow-list leaves out, before the gateway, and lets an allowed one through', async () => {
  await setAllowList(['anthropic'])
  expect(await relayedCallOf('mistral/codestral-latest')).toEqual({
    status: 403,
    body: { error: { message: 'codestral-latest is not allowed in this workspace', type: 'spyria_refused' } },
    reached: 0,
  })
  await setAllowList(['mistral'])
  expect(await relayedCallOf('mistral/codestral-latest')).toMatchObject({ status: 200, reached: 1 })
  for (const fields of [{ fallbacks: ['openai/gpt-5'] }, { Model: 'openai/gpt-5' }])
    expect(await relayedCallOf('mistral/codestral-latest', fields)).toMatchObject({ status: 403, reached: 0 })
})
