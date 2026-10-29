import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { fakeSearchResult } from './testing/fake-llm.ts'
import {
  acme,
  addLlmKey,
  alice,
  bob,
  createFakeHosts,
  gatewayLogsOf,
  openSharedTestApp,
  rpcOf,
  runtimeTurn,
  virtualKeyOf,
} from './testing/testing.ts'

setDefaultTimeout(30_000)
const { database, port, gateway, fakeLlmCalls, fakeLlmBodies } = await openSharedTestApp()
const { fakeHost, disconnectFakeHosts } = createFakeHosts({ port, database })
afterAll(() => disconnectFakeHosts())

const anthropicSecret = `fake-key-anthropic-${crypto.randomUUID()}`
await addLlmKey(bob, 'Anthropic', anthropicSecret)

const webToolCall = async (host: Awaited<ReturnType<typeof fakeHost>>, token: string, body: string) => {
  const answer = await host.modelCall({
    path: '/mcp/web',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body,
  })
  return { status: answer.status, result: JSON.parse(answer.body || '{}').result }
}

test('a runtime lists web search, and searches only during a turn', async () => {
  const host = await fakeHost('Web search listing host')
  const { token } = await runtimeTurn(host, null)
  expect(
    (await webToolCall(host, token, rpcOf('tools/list'))).result.tools.map(({ name }: { name: string }) => name),
  ).toEqual(['web_search'])
  expect(
    (await webToolCall(host, token, rpcOf('tools/call', { name: 'web_search', arguments: { query: 'zero' } }))).result,
  ).toEqual({ content: [{ type: 'text', text: 'This runtime has no active turn' }], isError: true })
  expect((await webToolCall(host, 'not-a-runtime-token', rpcOf('tools/list'))).status).toBe(401)
})

test('a web search runs on the prompter’s own key through the provider’s search tool, is billed to the turn and recorded', async () => {
  const host = await fakeHost('Web search host')
  const { chatId, token, promptId } = await runtimeTurn(host, bob)
  const callsBefore = fakeLlmCalls.length
  const searched = await webToolCall(
    host,
    token,
    rpcOf('tools/call', { name: 'web_search', arguments: { query: 'zero sync' } }),
  )
  const text = searched.result.content[0].text
  expect(searched.result.isError).toBe(false)
  expect(text).toStartWith('Zero syncs Postgres to the browser (searched: zero sync).')
  expect(text).toContain(`Sources:\n- ${fakeSearchResult.title}: ${fakeSearchResult.url}`)
  const providerCall = fakeLlmCalls[callsBefore]
  expect(providerCall?.['x-api-key']).toBe(anthropicSecret)
  const providerRequest = JSON.parse(fakeLlmBodies[callsBefore] ?? '{}') as {
    model?: string
    tools?: { type?: string }[]
  }
  expect(providerRequest.model).toBe('claude-haiku-5-5')
  expect(providerRequest.tools?.map((tool) => tool.type?.replace(/_\d+$/, ''))).toEqual(['web_search'])
  const bobKey = await virtualKeyOf(bob)
  expect(
    (await gatewayLogsOf(gateway, `virtual_key_ids=${bobKey.id}&metadata_turn=${promptId}`))[0]?.metadata,
  ).toMatchObject({ chat: chatId, prompter: bob, owner: alice, workspace: acme, turn: promptId })
  expect([
    ...(await database.$client`
        select server, tool, read_only, status, prompter_id, owner_id from tool_calls where chat_id = ${chatId}`),
  ]).toEqual([
    {
      server: 'spyria',
      tool: 'web_search',
      read_only: true,
      status: 'succeeded',
      prompter_id: bob,
      owner_id: alice,
    },
  ])
})

test('a blank query is refused without a model call', async () => {
  const host = await fakeHost('Blank web search host')
  const { token } = await runtimeTurn(host, bob)
  const callsBefore = fakeLlmCalls.length
  expect(
    (await webToolCall(host, token, rpcOf('tools/call', { name: 'web_search', arguments: { query: ' ' } }))).result,
  ).toEqual({ content: [{ type: 'text', text: 'Give the words to search for' }], isError: true })
  expect(fakeLlmCalls.length).toBe(callsBefore)
})
