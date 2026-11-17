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

const refuseTurnEnds = async (times: number) => {
  await database.$client.unsafe('create sequence turn_end_record_failures')
  await database.$client.unsafe(
    `create function refuse_turn_end_records() returns trigger language plpgsql as $$ begin
       if new.type = 'agent.event' and new.payload->'event'->'update'->>'sessionUpdate' = 'turn_end'
         and nextval('turn_end_record_failures') <= ${times} then raise exception 'The turn end record is refused'; end if;
       return new; end $$`,
  )
  await database.$client.unsafe(
    'create trigger refuse_turn_end_records before insert on events for each row execute function refuse_turn_end_records()',
  )
  return async () => {
    await database.$client.unsafe('drop trigger refuse_turn_end_records on events')
    await database.$client.unsafe('drop function refuse_turn_end_records')
    await database.$client.unsafe('drop sequence turn_end_record_failures')
  }
}
const turnEndsOf = (chat: string) => database.$client`
  select id from events where chat_id = ${chat} and payload->'event'->'update'->>'sessionUpdate' = 'turn_end'`

test('a turn end whose recording fails for a moment is recorded again, so the turn ends with its reply', async () => {
  await stack.agentHost('Failing record host', { holdUrl })
  const chat = await newRuntimeChat()
  const allowTurnEnds = await refuseTurnEnds(2)
  const capturedConsole = captureConsole()
  try {
    const question = await prompt(chat, 'Say hello')
    await waitFor(async () => (await turnEndsOf(chat)).length > 0, 20_000)
    await waitFor(async () => (await turnOf(chat)) === null)
    const replyKinds = (await stack.repliesTo(question)).map(({ kind }) => kind)
    expect({ hasReply: replyKinds.includes('agent'), hasNotice: replyKinds.includes('notice') }).toEqual({
      hasReply: true,
      hasNotice: false,
    })
  } finally {
    capturedConsole.restore()
    await allowTurnEnds()
  }
  expect(await turnEndsOf(chat)).toHaveLength(1)
})

test('a turn end that can never be recorded still ends the turn, with its reply and no notice that the agent did not respond', async () => {
  await stack.agentHost('Unrecordable turn end host', { holdUrl })
  const chat = await newRuntimeChat()
  const allowTurnEnds = await refuseTurnEnds(1_000)
  const capturedConsole = captureConsole()
  try {
    const question = await prompt(chat, 'Say hello')
    await stack.answered(question)
    await waitFor(async () => (await turnOf(chat)) === null, 20_000)
    const replyKinds = (await stack.repliesTo(question)).map(({ kind }) => kind)
    expect({ hasReply: replyKinds.includes('agent'), hasNotice: replyKinds.includes('notice') }).toEqual({
      hasReply: true,
      hasNotice: false,
    })
  } finally {
    capturedConsole.restore()
    await allowTurnEnds()
  }
  expect(await turnEndsOf(chat)).toHaveLength(0)
}, 60_000)
