import { expect, test } from 'bun:test'
import { createMockSnapshot, type Snapshot } from '@hq/db'
import { chatId, memberId, messageId, workspaceId } from '@hq/kernel'
import { durationLabelOf, getConversation } from './get-conversation.ts'

const acme = workspaceId('workspace-acme')
const research = chatId('chat-research')
const alice = memberId('member-alice')
const prompt = messageId('message-prompt')

const snapshotWith = ({ turn, waiting }: { turn: boolean; waiting: boolean }): Snapshot => {
  const snapshot = createMockSnapshot()
  return {
    ...snapshot,
    chats: snapshot.chats.map((chat) =>
      chat.id === research ? { ...chat, agentTurnMessageId: turn ? prompt : null } : chat,
    ),
    messages: [
      ...snapshot.messages,
      {
        id: prompt,
        workspaceId: acme,
        chatId: research,
        seq: 1,
        kind: 'member',
        authorId: alice,
        body: 'Find the latest pricing',
        detail: null,
        step: null,
        replyToId: null,
        createdAt: '2026-10-01T09:00:00.000Z',
        editedAt: null,
        deletedAt: null,
        needsReply: waiting,
      },
    ],
  }
}
const activityOf = (state: { turn: boolean; waiting: boolean }) => {
  const conversation = getConversation(acme, research, alice)(snapshotWith(state))
  return { isAgentWorking: conversation?.isAgentWorking, hasActiveTurn: conversation?.hasActiveTurn }
}

test('the agent works while the chat has an active turn or a prompt waiting for its turn; Stop needs the turn', () => {
  expect(activityOf({ turn: false, waiting: false })).toEqual({ isAgentWorking: false, hasActiveTurn: false })
  expect(activityOf({ turn: true, waiting: false })).toEqual({ isAgentWorking: true, hasActiveTurn: true })
  expect(activityOf({ turn: false, waiting: true })).toEqual({ isAgentWorking: true, hasActiveTurn: false })
  expect(activityOf({ turn: true, waiting: true })).toEqual({ isAgentWorking: true, hasActiveTurn: true })
})

const turnStart = Date.UTC(2026, 9, 1, 9, 0)
type StepRow = Snapshot['messages'][number]['step']
const replyRow = (
  seq: number,
  kind: 'agent' | 'step' | 'notice',
  fields: { body?: string; step?: StepRow; at?: number; replyToId?: string | null } = {},
) => ({
  id: messageId(`message-${seq}`),
  workspaceId: acme,
  chatId: research,
  seq,
  kind,
  authorId: null,
  body: fields.body ?? kind,
  detail: null,
  step: fields.step ?? null,
  replyToId: fields.replyToId === undefined ? prompt : fields.replyToId === null ? null : messageId(fields.replyToId),
  createdAt: new Date(turnStart + (fields.at ?? seq) * 1000).toISOString(),
  editedAt: null,
  deletedAt: null,
  needsReply: false,
})
const thought = { type: 'thought', text: 'Check the toolchain.', durationMilliseconds: 4000 } as const
const command = (exitCode: number | null) => ({
  type: 'command' as const,
  command: 'python3 --version',
  exitCode,
  durationMilliseconds: exitCode === null ? null : 1200,
  output: 'Python 3.12.3',
  truncatedLines: 0,
  thought,
})
const edit = { type: 'file', operation: 'edit', path: 'totals.ts', added: 2, removed: 1, diff: [] } as const
const plan = (status: string) => ({ type: 'plan' as const, items: [{ title: 'Fix totals', status }] })
const conversationWith = (rows: ReturnType<typeof replyRow>[], isTurnActive = false) => {
  const snapshot = snapshotWith({ turn: isTurnActive, waiting: false })
  return getConversation(acme, research, alice)({ ...snapshot, messages: [...snapshot.messages, ...rows] })
}
const itemSummaryOf = (conversation: ReturnType<typeof conversationWith>) =>
  conversation?.items.map((item) =>
    item.type === 'fold'
      ? `fold ${item.label}: ${item.steps.map((step) => step.step?.type).join(', ')}`
      : `${item.message.kind}${item.message.step ? ` ${item.message.step.type}` : ''}`,
  )

test('an ended turn folds its steps into one line above the answer, with the thought before its command', () => {
  const conversation = conversationWith([
    replyRow(2, 'step', { step: command(0), at: 5 }),
    replyRow(3, 'step', { step: edit, at: 20 }),
    replyRow(4, 'agent', { body: 'Fixed.', at: 77 }),
  ])
  expect(itemSummaryOf(conversation)).toEqual([
    'member',
    'fold Worked for 1m 12s · 3 steps: thought, command, file',
    'agent',
  ])
  const fold = conversation?.items[1]
  expect(fold?.type === 'fold' && fold.steps[0]?.step).toEqual(thought)
  expect(fold?.type === 'fold' && fold.steps[1]?.step).not.toHaveProperty('thought')
})

test('an active turn shows its steps live and unfolded, its pending command running', () => {
  const conversation = conversationWith([replyRow(2, 'step', { step: command(null) })], true)
  expect(itemSummaryOf(conversation)).toEqual(['member', 'step thought', 'step command'])
  const running = conversation?.items[2]
  expect(running?.type === 'message' && running.message.isRunning).toBe(true)
})

test('a turn with a single step, without an answer, stopped or failed stays unfolded', () => {
  const single = conversationWith([
    replyRow(2, 'step', { step: { ...command(0), thought: undefined } }),
    replyRow(3, 'agent', { body: 'Done.' }),
  ])
  expect(itemSummaryOf(single)).toEqual(['member', 'step command', 'agent'])
  const failed = conversationWith([
    replyRow(2, 'step', { step: command(0) }),
    replyRow(3, 'step', { step: { type: 'error', message: 'boom' } }),
    replyRow(4, 'notice', { body: 'The agent stopped with an error' }),
  ])
  expect(itemSummaryOf(failed)).toEqual(['member', 'step thought', 'step command', 'step error', 'notice'])
  const finishedRunning = failed?.items[2]
  expect(finishedRunning?.type === 'message' && finishedRunning.message.isRunning).toBe(false)
})

test('the error the interrupt causes is hidden in a stopped turn', () => {
  const stopped = conversationWith([
    replyRow(2, 'step', { step: edit }),
    replyRow(3, 'notice', { body: 'Stopped by Alice' }),
    replyRow(4, 'step', { step: { type: 'error', message: 'Tool call interrupted before completion.' } }),
  ])
  expect(itemSummaryOf(stopped)).toEqual(['member', 'step file', 'notice'])
})

test('a turn shows only its latest plan, where the plan first appeared', () => {
  const conversation = conversationWith(
    [
      replyRow(2, 'step', { step: plan('todo') }),
      replyRow(3, 'step', { step: edit }),
      replyRow(4, 'step', { step: plan('done') }),
    ],
    true,
  )
  expect(itemSummaryOf(conversation)).toEqual(['member', 'step plan', 'step file'])
  const shownPlan = conversation?.items[1]
  expect(shownPlan?.type === 'message' && shownPlan.message.step).toEqual(plan('done'))
})

test('steps outside any turn, like migrated tool calls, are shown as they are', () => {
  const conversation = conversationWith([
    replyRow(2, 'step', { step: { ...command(null), thought: undefined }, replyToId: null }),
    replyRow(3, 'agent', { body: 'Done.', replyToId: null }),
  ])
  expect(itemSummaryOf(conversation)).toEqual(['member', 'step command', 'agent'])
  const legacy = conversation?.items[1]
  expect(legacy?.type === 'message' && legacy.message.isRunning).toBe(false)
})

test('durations read in seconds, tenths under ten seconds, and minutes', () => {
  expect(durationLabelOf(400)).toBe('0.4s')
  expect(durationLabelOf(4000)).toBe('4s')
  expect(durationLabelOf(12_400)).toBe('12s')
  expect(durationLabelOf(72_000)).toBe('1m 12s')
})
