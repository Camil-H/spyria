import { expect, setDefaultTimeout, test } from 'bun:test'
import { startAgentStack, waitFor } from '../testing/testing.ts'

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
