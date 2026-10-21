import { afterAll, expect, test } from 'bun:test'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { acme, alice } from './mock-data.ts'
import { createTestDatabase, databaseDropTimeoutMilliseconds } from './postgres/testing.ts'
import { activeAgentTurns, openTaskStepsOf, pendingPrompts } from './server-writes.ts'
import { schema } from './zero.ts'
import type { Transact } from './zero-queries.ts'

const testDatabase = await createTestDatabase()
const { database } = testDatabase
afterAll(() => testDatabase.drop(), databaseDropTimeoutMilliseconds)
const zeroDatabase = zeroDrizzle(schema, database)
const inTransaction: Transact = (work) => zeroDatabase.transaction(work)

const chat = 'chat-queries'
const waitingNotice = 'Waiting for the current turn'
await database.$client`
  insert into chats (workspace_id, id, type, visibility, owner_kind, owner_user_id, name, archived, created_at,
    agent_turn_message_id)
  values (${acme}, ${chat}, 'runtime', 'private', 'user', ${alice}, 'Queries', false, now(), 'prompt-4')`
const message = (seq: number, id: string, kind: string, fields: Record<string, unknown> = {}) => ({
  workspace_id: acme,
  chat_id: chat,
  id,
  seq,
  kind,
  author_id: kind === 'member' ? alice : null,
  body: id,
  reply_to_id: null,
  step: null,
  deleted_at: null,
  created_at: new Date().toISOString(),
  ...fields,
})
const taskStep = (result: string | null) => JSON.stringify({ type: 'tool', name: 'Task', arguments: '{}', result })
const messageRows = [
  message(1, 'prompt-1', 'member'),
  message(2, 'reply-1', 'agent', { reply_to_id: 'prompt-1' }),
  message(3, 'prompt-2', 'member', { deleted_at: new Date().toISOString() }),
  message(4, 'prompt-3', 'member'),
  message(5, 'notice-3', 'notice', { reply_to_id: 'prompt-3', body: 'The agent stopped' }),
  message(6, 'prompt-4', 'member'),
  message(7, 'prompt-5', 'member'),
  message(8, 'notice-5', 'notice', { reply_to_id: 'prompt-5', body: waitingNotice }),
  message(9, 'prompt-6', 'member'),
  message(10, 'task-open-1', 'step', { reply_to_id: 'prompt-4', step: taskStep(null) }),
  message(11, 'task-done', 'step', { reply_to_id: 'prompt-4', step: taskStep('Done') }),
  message(12, 'bash-open', 'step', {
    reply_to_id: 'prompt-4',
    step: JSON.stringify({ type: 'tool', name: 'Bash', result: null }),
  }),
  message(13, 'task-open-2', 'step', { reply_to_id: 'prompt-4', step: taskStep(null) }),
]
await database.$client`insert into messages ${database.$client(messageRows)}`
const lastEventAt = new Date(Date.now() - 1000)
await database.$client`insert into events ${database.$client(
  [3, 2, 1].map((secondsAgo, index) => ({
    workspace_id: acme,
    chat_id: chat,
    id: `event-${index + 1}`,
    seq: index + 1,
    type: 'agent.event',
    payload: '{}',
    created_at: new Date(lastEventAt.getTime() - (secondsAgo - 1) * 1000).toISOString(),
  })),
)}`

test('pending prompts are the unanswered prompts after the last answered one, waiting notices and the active turn aside', async () => {
  expect(await inTransaction((tx) => pendingPrompts(tx, acme, chat, [waitingNotice]))).toEqual(['prompt-5', 'prompt-6'])
})

test('an active turn reports the time of its chat’s last event by sequence', async () => {
  const turns = await inTransaction((tx) => activeAgentTurns(tx, acme))
  expect(turns).toEqual([{ chatId: chat, promptId: 'prompt-4', lastEventAt: lastEventAt.getTime() }])
})

test('the open Task steps of a prompt are its Task tool steps without a result, in order', async () => {
  const steps = await inTransaction((tx) => openTaskStepsOf(tx, acme, 'prompt-4'))
  expect(steps.map((step) => step.id)).toEqual(['task-open-1', 'task-open-2'])
})
