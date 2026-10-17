import { expect, test } from 'bun:test'
import { acme, type MessageRow } from '@hq/db'
import { chatId, messageId } from '@hq/kernel'
import { approvedPlanOf } from './get-plan.ts'

const stepAt = (seq: number, step: MessageRow['step']): MessageRow => ({
  id: messageId(`message-${seq}`),
  workspaceId: acme,
  chatId: chatId('chat-plan'),
  seq,
  kind: 'step',
  authorId: null,
  body: String(step?.type),
  detail: null,
  step,
  replyToId: null,
  threadRootId: null,
  createdAt: '2026-10-16T10:00:00.000Z',
  editedAt: null,
  deletedAt: null,
  needsReply: false,
})
const planQuestion = (seq: number, approved: boolean, plan = `Plan ${seq}`) =>
  stepAt(seq, { type: 'question', questionId: `q-${seq}`, kind: 'plan', plan, approved })
const checklist = (seq: number) => stepAt(seq, { type: 'plan', items: [{ title: 'Fix', status: 'todo' }] })

test('the latest approved plan shows until a newer checklist replaces it', () => {
  expect(approvedPlanOf([])).toBeNull()
  expect(approvedPlanOf([planQuestion(1, true, '# Fix the totals')])).toBe('# Fix the totals')
  expect(approvedPlanOf([planQuestion(1, true), checklist(2)])).toBeNull()
  expect(approvedPlanOf([checklist(1), planQuestion(2, true)])).toBe('Plan 2')
  expect(approvedPlanOf([planQuestion(3, true), planQuestion(1, true)])).toBe('Plan 3')
})

test('a plan that was not approved, a question and delegated steps are ignored', () => {
  expect(approvedPlanOf([planQuestion(1, false)])).toBeNull()
  expect(approvedPlanOf([planQuestion(1, true), planQuestion(2, false)])).toBe('Plan 1')
  expect(
    approvedPlanOf([stepAt(1, { type: 'question', questionId: 'q', kind: 'question', approved: true, plan: 'x' })]),
  ).toBeNull()
  const delegatedChecklist = stepAt(2, { type: 'plan', items: [], delegation: { id: 'd' } })
  expect(approvedPlanOf([planQuestion(1, true), delegatedChecklist])).toBe('Plan 1')
  const delegatedPlan = stepAt(3, {
    type: 'question',
    questionId: 'q',
    kind: 'plan',
    plan: 'x',
    approved: true,
    delegation: {},
  })
  expect(approvedPlanOf([delegatedPlan])).toBeNull()
})
