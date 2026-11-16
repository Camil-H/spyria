import { expect, test } from 'bun:test'
import { agentNotices } from './agent-events.ts'
import { isQueuedPrompt, joinsRunningTurn } from './queued-prompts.ts'

const prompt = { kind: 'member', replyToId: null, pickedUpAt: null }
const waitingNotice = { kind: 'notice', body: agentNotices.hostOffline }

test('a prompt is queued until the agent picks it up: while it waits behind a turn or for the runtime, not once picked up or answered', () => {
  expect(isQueuedPrompt(prompt, [])).toBe(true)
  expect(isQueuedPrompt(prompt, [waitingNotice])).toBe(true)
  expect(isQueuedPrompt({ ...prompt, pickedUpAt: new Date() }, [])).toBe(false)
  expect(isQueuedPrompt(prompt, [waitingNotice, { kind: 'agent', body: 'Done.' }])).toBe(false)
  expect(isQueuedPrompt(prompt, [{ kind: 'notice', body: 'The agent stopped before finishing' }])).toBe(false)
  expect(isQueuedPrompt({ ...prompt, kind: 'agent' }, [])).toBe(false)
})

test("only the turn's own prompter joins a running turn, so the turn stays on one member's key, and quality gates prompts never join or are joined", () => {
  expect(joinsRunningTurn({ authorId: 'alice' }, { authorId: 'alice' })).toBe(true)
  expect(joinsRunningTurn({ authorId: 'alice' }, { authorId: 'bob' })).toBe(false)
  expect(joinsRunningTurn({ authorId: null }, { authorId: null })).toBe(false)
  expect(joinsRunningTurn({ authorId: 'alice', step: { type: 'dev_loop_prompt' } }, { authorId: 'alice' })).toBe(false)
  expect(joinsRunningTurn({ authorId: 'alice' }, { authorId: 'alice', step: { type: 'dev_loop_prompt' } })).toBe(false)
})
