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
const relayedCallOf = async (model: string) => {
  const host = await fakeHost('Provider host')
  const { token } = await runtimeTurn(host, bob)
  const callsBefore = fakeLlmCalls.length
  const answer = await host.modelCall({
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
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
  expect(await setAllowList({ anthropic: 'all' }, bobInAcme)).toEqual(
    failedWith('Your workspace role does not allow this: Manage AI providers and models'),
  )
  expect(await setAllowList({ fake: 'all' })).toEqual(failedWith('fake is not a supported provider'))
  expect(await setAllowList({ anthropic: 'all', mistral: ['mistral/codestral-latest'], openai: [] })).toEqual(succeeded)
  const [workspace] = await database.$client`select ai_provider_allow_list from workspaces where workspace_id = ${acme}`
  expect(workspace?.ai_provider_allow_list).toEqual({ anthropic: 'all', mistral: ['mistral/codestral-latest'] })
  expect((await workspaceEventsOf(database)).filter(({ type }) => type === 'ai_providers.changed')).toEqual([
    {
      type: 'ai_providers.changed',
      actorId: aliceInAcme.userId,
      payload: { allowed: ['Anthropic', 'Mistral (mistral/codestral-latest)'] },
    },
  ])
})

test('a key for a provider left out of the allow-list is refused before it reaches the gateway', async () => {
  await setAllowList({ anthropic: 'all' })
  const refused = await asMember(bob, 'POST', '/api/llm-credentials', { provider: 'OpenAI', secret: 'sk-test-1234' })
  expect(refused.status).toBe(400)
  expect(JSON.parse(refused.body)).toEqual({
    error: 'provider_not_allowed',
    message: 'OpenAI is not allowed in this workspace',
  })
})

test('the relay refuses a model the allow-list leaves out, before the gateway, and lets an allowed one through', async () => {
  await setAllowList({ mistral: ['mistral/codestral-latest'] })
  expect(await relayedCallOf('mistral/mistral-large-latest')).toEqual({
    status: 403,
    body: { error: { message: 'mistral-large-latest is not allowed in this workspace', type: 'spyria_refused' } },
    reached: 0,
  })
  expect(await relayedCallOf('mistral/codestral-latest')).toMatchObject({ status: 200, reached: 1 })
})
