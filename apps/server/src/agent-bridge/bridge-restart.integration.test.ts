import { expect, setDefaultTimeout, test } from 'bun:test'
import { captureConsole, startAgentStack, waitFor } from '../testing/testing.ts'

setDefaultTimeout(30_000)
const { database, agentBridge, newRuntimeChat, prompt, openStream, holds, holdUrl, turnOf, ...stack } =
  await startAgentStack({ llm: { model: 'openai/mistral/codestral-latest' } })

test('after a server restart mid-turn, viewers get the reply so far as a snapshot, so the text the agent replays is not shown twice', async () => {
  await stack.agentHost('Restarting server host', { holdUrl })
  const chat = await newRuntimeChat()
  const viewer = await openStream(chat)
  await viewer.subscribed
  const question = await prompt(chat, 'stub:pause Stream across a restart')
  await holds.reached('pause')
  await waitFor(() => viewer.frames.some((frame) => JSON.parse(frame).text))

  agentBridge.release(database)
  const reconnected = await openStream(chat)
  await reconnected.subscribed
  await agentBridge.forDatabase(database).resumeActiveTurns()
  await holds.release('pause')
  await stack.answered(question)
  await waitFor(async () => (await turnOf(chat)) === null)
  const texts = reconnected.frames.map((frame) => JSON.parse(frame)).filter((frame) => frame.text !== undefined)
  expect(texts[0]).toMatchObject({ chatId: chat, promptId: question, isSnapshot: true })
  expect(texts.slice(1).every((frame) => !frame.isSnapshot)).toBe(true)
  const [reply] = await stack.repliesTo(question)
  expect(texts.map((frame) => frame.text).join('')).toBe(reply?.body ?? '')
})

test('an agent event whose recording keeps failing is recorded again, and read again from the agent when retries run out, so the turn still ends with its reply', async () => {
  await stack.agentHost('Failing record host', { holdUrl })
  const chat = await newRuntimeChat()
  await database.$client.unsafe('create sequence turn_end_record_failures')
  await database.$client.unsafe(
    `create function refuse_turn_end_records() returns trigger language plpgsql as $$ begin
       if new.type = 'agent.event' and new.payload->'event'->'update'->>'sessionUpdate' = 'turn_end'
         and nextval('turn_end_record_failures') <= 4 then raise exception 'The turn end record is refused'; end if;
       return new; end $$`,
  )
  await database.$client.unsafe(
    'create trigger refuse_turn_end_records before insert on events for each row execute function refuse_turn_end_records()',
  )
  const capturedConsole = captureConsole()
  try {
    const question = await prompt(chat, 'Say hello')
    await stack.answered(question)
    await waitFor(async () => (await turnOf(chat)) === null, 20_000)
    expect((await stack.repliesTo(question)).length).toBeGreaterThan(0)
  } finally {
    capturedConsole.restore()
    await database.$client.unsafe('drop trigger refuse_turn_end_records on events')
    await database.$client.unsafe('drop function refuse_turn_end_records')
    await database.$client.unsafe('drop sequence turn_end_record_failures')
  }
  const turnEnds = await database.$client`
    select id from events where chat_id = ${chat} and payload->'event'->'update'->>'sessionUpdate' = 'turn_end'`
  expect(turnEnds).toHaveLength(1)
})

test('an agent event that can never be recorded is read again from the agent once, then skipped, so the turn still ends', async () => {
  await stack.agentHost('Unrecordable event host', { holdUrl })
  const chat = await newRuntimeChat()
  await database.$client.unsafe(
    `create function refuse_agent_messages() returns trigger language plpgsql as $$ begin
       if new.type = 'agent.event' and new.payload->'event'->'update'->>'sessionUpdate' = 'agent_message' then
         raise exception 'The agent message record is refused'; end if;
       return new; end $$`,
  )
  await database.$client.unsafe(
    'create trigger refuse_agent_messages before insert on events for each row execute function refuse_agent_messages()',
  )
  const turnEndsOf = () => database.$client`
    select id from events where chat_id = ${chat} and payload->'event'->'update'->>'sessionUpdate' = 'turn_end'`
  const capturedConsole = captureConsole()
  try {
    await prompt(chat, 'Say hello')
    await waitFor(async () => (await turnEndsOf()).length > 0, 40_000)
  } finally {
    capturedConsole.restore()
    await database.$client.unsafe('drop trigger refuse_agent_messages on events')
    await database.$client.unsafe('drop function refuse_agent_messages')
  }
  await waitFor(async () => (await turnOf(chat)) === null)
  expect(await turnEndsOf()).toHaveLength(1)
}, 60_000)
