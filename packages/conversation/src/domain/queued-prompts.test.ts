import { expect, test } from 'bun:test'
import { agentNotices } from './agent-events.ts'
import { isQueuedPrompt, joinsRunningTurn } from './queued-prompts.ts'

const prompt = { id: 'prompt-2', kind: 'member', replyToId: null, pickedUpAt: null }
const waitingNotice = { kind: 'notice', body: agentNotices.hostOffline }

test('a prompt is queued until the agent picks it up: while it waits behind a turn or for the runtime, not once it runs, was taken into a turn or got an answer', () => {
  expect(isQueuedPrompt(prompt, 'prompt-1', [])).toBe(true)
  expect(isQueuedPrompt(prompt, null, [waitingNotice])).toBe(true)
  expect(isQueuedPrompt(prompt, 'prompt-2', [])).toBe(false)
  expect(isQueuedPrompt({ ...prompt, pickedUpAt: new Date() }, 'prompt-1', [])).toBe(false)
  expect(isQueuedPrompt(prompt, null, [waitingNotice, { kind: 'agent', body: 'Done.' }])).toBe(false)
  expect(isQueuedPrompt(prompt, null, [{ kind: 'notice', body: 'The agent stopped before finishing' }])).toBe(false)
  expect(isQueuedPrompt({ ...prompt, kind: 'agent' }, null, [])).toBe(false)
})

test("only the turn's own prompter joins a running turn, so the turn stays on one member's key, and never a quality gates turn", () => {
  expect(joinsRunningTurn({ authorId: 'alice' }, { authorId: 'alice' })).toBe(true)
  expect(joinsRunningTurn({ authorId: 'alice' }, { authorId: 'bob' })).toBe(false)
  expect(joinsRunningTurn({ authorId: null }, { authorId: null })).toBe(false)
  expect(joinsRunningTurn({ authorId: 'alice', step: { type: 'dev_loop_prompt' } }, { authorId: 'alice' })).toBe(false)
})
