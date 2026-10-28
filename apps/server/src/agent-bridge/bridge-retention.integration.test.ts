import { expect, setDefaultTimeout, test } from 'bun:test'
import { acme, bob, bobInAcme, startAgentStack, succeeded, waitFor } from '../testing/testing.ts'

setDefaultTimeout(60_000)
const { database, agentBridge, mutate, newRuntimeChat, prompt, turnIs, answered, holdUrl, openStream, ...stack } =
  await startAgentStack({ llm: { model: 'openai/fake' } })
const retained = () => agentBridge.forDatabase(database).retained()
const nothingRetained = {
  turnSpans: 0,
  viewers: 0,
  watchingViewers: 0,
  shownQuestions: 0,
  delegatedTexts: 0,
  streamedSeqs: 0,
}
const settlesEmpty = async () => {
  await waitFor(() => JSON.stringify(retained()) === JSON.stringify(nothingRetained))
  expect(retained()).toEqual(nothingRetained)
}

const keylessPrompt = async (chat: string) => {
  const promptId = `message-${crypto.randomUUID()}`
  await database.$client.begin(async (sql) => {
    await sql`
      insert into messages (workspace_id, chat_id, id, seq, kind, author_id, body, created_at)
      values (${acme}, ${chat}, ${promptId}, 1, 'member', ${bob}, 'Queued prompt', now())`
    await sql`
      insert into events (workspace_id, chat_id, id, seq, type, actor, payload, created_at)
      values (${acme}, ${chat}, ${promptId}, 1, 'message.posted', ${bob}, '{}'::jsonb, now())`
    await sql`
      insert into jobs (workspace_id, id, type, payload, run_at, attempts, state)
      values (${acme}, ${crypto.randomUUID()}, 'agent.prompt', ${JSON.stringify({ messageId: promptId })}::jsonb, now(), 0, 'queued')`
  })
  return promptId
}

test('every turn-closing path leaves no turn span, viewer, shown question, delegated text or streamed position behind', async () => {
  const hostless = await newRuntimeChat()
  await answered(await prompt(hostless, 'Nobody runs me'))
  await settlesEmpty()

  const { host } = await stack.agentHost('Agent host', { holdUrl })
  const answeredChat = await newRuntimeChat()
  const viewer = await openStream(answeredChat)
  await viewer.subscribed
  const answeredPrompt = await prompt(answeredChat, 'Hello')
  await answered(answeredPrompt)
  await turnIs(answeredChat, null)
  expect(retained().viewers).toBe(1)
  viewer.close()
  await viewer.closed
  await settlesEmpty()

  const erroring = await newRuntimeChat()
  await answered(await prompt(erroring, 'stub:fail Break the turn'), 2)
  await turnIs(erroring, null)
  await settlesEmpty()

  const keyless = await newRuntimeChat({ participants: [{ memberId: bob, roleId: 'prompter' }] })
  await answered(await keylessPrompt(keyless))
  await settlesEmpty()

  const stopped = await newRuntimeChat({ participants: [{ memberId: bob, roleId: 'editor' }] })
  const longPrompt = await prompt(stopped, 'stub:long Take your time')
  await stack.commandShown(longPrompt, 20_000)
  expect(retained().turnSpans).toBe(1)
  expect(await mutate(bobInAcme, 'conversation.stopAgent', { workspaceId: acme, chatId: stopped })).toEqual(succeeded)
  await turnIs(stopped, null)
  await settlesEmpty()

  host.failing('create')
  const unstartable = await newRuntimeChat()
  await answered(await prompt(unstartable, 'Start please'))
  await turnIs(unstartable, null)
  await settlesEmpty()
})
