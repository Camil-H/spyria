import { expect, setDefaultTimeout, test } from 'bun:test'
import {
  acme,
  addLlmKey,
  aliceInAcme,
  bob,
  bobInAcme,
  failedWith,
  startAgentStack,
  succeeded,
  waitFor,
} from '../testing/testing.ts'

setDefaultTimeout(30_000)
const { database, mutate, newRuntimeChat, prompt, turnOf, holds, holdUrl, jobDone, answered, ...stack } =
  await startAgentStack({ llm: { model: 'openai/mistral/codestral-latest' } })
const repliesTo = (messageId: string) => stack.repliesTo(messageId, ['kind', 'body'])
const agentHost = () => stack.agentHost('Agent host', { holdUrl })
const stubHello = 'Hello from the stub (model spyria/mistral/codestral-latest, mode default).'
const turnEnded = (chat: string) => waitFor(async () => (await turnOf(chat as never)) === null)
const chatTurnOf = async (chat: string) => {
  const [turn] = await database.$client<{ promptId: string | null; prompterId: string | null }[]>`
    select agent_turn_message_id as "promptId", agent_turn_prompter_id as "prompterId" from chats where id = ${chat}`
  return turn
}
const pickedUpAtOf = async (messageId: string) => {
  const [message] = await database.$client<{ pickedUpAt: Date | null }[]>`
    select picked_up_at as "pickedUpAt" from messages where id = ${messageId}`
  return message?.pickedUpAt ?? null
}
const edit = (member: typeof aliceInAcme, messageId: string, text: string) =>
  mutate(member, 'conversation.editMessage', { workspaceId: acme, messageId, text })
const remove = (member: typeof aliceInAcme, messageId: string) =>
  mutate(member, 'conversation.deleteMessage', { workspaceId: acme, messageId })
const pickedUpRefusal = failedWith('The agent has already picked up this message, so it can no longer be changed')

test('a message the prompter sends while their turn runs is taken into it: the turn moves to the message, keeps its prompter, and ends under it', async () => {
  const { relay } = await agentHost()
  const chat = await newRuntimeChat()
  const first = await prompt(chat, 'stub:linger Rename the module')
  await waitFor(() => relay.prompts.length === 1)
  const joined = await prompt(chat, 'stub:linger and update its imports')
  await jobDone('agent.prompt', { messageId: joined })
  expect(relay.joins).toEqual(['stub:linger and update its imports'])
  expect(await pickedUpAtOf(joined)).not.toBeNull()
  expect(await edit(aliceInAcme, joined, 'Never mind')).toEqual(pickedUpRefusal)
  expect(await chatTurnOf(chat)).toEqual({ promptId: first, prompterId: aliceInAcme.userId })

  await holds.release('linger')
  await holds.reached('steered')
  await waitFor(async () => (await chatTurnOf(chat))?.promptId === joined)
  expect(await chatTurnOf(chat)).toEqual({ promptId: joined, prompterId: aliceInAcme.userId })
  await holds.release('steered')
  await turnEnded(chat)
  expect(await repliesTo(first)).toEqual([{ kind: 'agent', body: '[t1]' }])
  expect(await repliesTo(joined)).toEqual([
    { kind: 'agent', body: `Took in: stub:linger and update its imports. ${stubHello}` },
  ])
  expect(relay.prompts).toEqual(['stub:linger Rename the module'])
  expect(await remove(aliceInAcme, joined)).toEqual(pickedUpRefusal)
})

test('a message from another member waits for the running turn to end and starts its own turn, editable by its author only until then', async () => {
  const { relay } = await agentHost()
  await addLlmKey(bob, 'OpenAI')
  const chat = await newRuntimeChat({ participants: [{ memberId: bob, roleId: 'prompter' }] })
  const first = await prompt(chat, 'stub:linger Rename the module')
  await waitFor(() => relay.prompts.length === 1)
  const bobs = await prompt(chat, 'Also add a changelog entry', bobInAcme)
  await jobDone('agent.prompt', { messageId: bobs })
  expect(relay.joins).toEqual([])
  expect(await pickedUpAtOf(bobs)).toBeNull()
  expect(await edit(aliceInAcme, bobs, 'Hijacked')).not.toEqual(succeeded)
  expect(await edit(bobInAcme, bobs, 'Also add a short changelog entry')).toEqual(succeeded)

  await holds.release('linger')
  await answered(bobs)
  await turnEnded(chat)
  expect(relay.prompts).toEqual(['stub:linger Rename the module', 'Also add a short changelog entry'])
  expect(await repliesTo(first)).toEqual([{ kind: 'agent', body: `[t1] ${stubHello}` }])
  expect(await repliesTo(bobs)).toEqual([{ kind: 'agent', body: `[t2] ${stubHello}` }])
  expect(await edit(bobInAcme, bobs, 'Too late')).toEqual(pickedUpRefusal)
})

test('a message the runtime refuses to take into the running turn goes back to the queue and runs once, as the next turn', async () => {
  const { relay } = await stack.agentHost('Agent host', {
    holdUrl,
    containerAgentOf: (relay) => ({
      ...relay.containerAgent,
      respond: async (request, container) => {
        if (!request.path.endsWith('/joins')) return relay.containerAgent.respond(request, container)
        relay.joins.push(JSON.parse(request.body ?? '{}').content?.[0]?.text)
        return { status: 409, body: '{"error":"Refused on purpose"}' }
      },
    }),
  })
  const chat = await newRuntimeChat()
  const first = await prompt(chat, 'stub:linger Rename the module')
  await waitFor(() => relay.prompts.length === 1)
  const refused = await prompt(chat, 'And the tests')
  await jobDone('agent.prompt', { messageId: refused })
  expect(relay.joins).toEqual(['And the tests'])
  expect(await pickedUpAtOf(refused)).toBeNull()

  await holds.release('linger')
  await answered(refused)
  await turnEnded(chat)
  expect(relay.prompts).toEqual(['stub:linger Rename the module', 'And the tests'])
  expect(await repliesTo(first)).toEqual([{ kind: 'agent', body: `[t1] ${stubHello}` }])
  expect(await repliesTo(refused)).toEqual([{ kind: 'agent', body: `[t2] ${stubHello}` }])
})
