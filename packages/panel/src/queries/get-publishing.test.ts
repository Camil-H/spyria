import { expect, test } from 'bun:test'
import { acme, alice, createMockSnapshot, type MessageRow } from '@spyria/db'
import { chatId, messageId } from '@spyria/kernel'
import { getPublishing } from './get-publishing.ts'

const devChat = chatId('chat-invoice-bug')
const cardAt = (seq: number, state: string): MessageRow => ({
  id: messageId(`message-card-${seq}`),
  workspaceId: acme,
  chatId: devChat,
  seq,
  kind: 'step',
  authorId: alice,
  body: 'pull_request',
  attachments: [],
  detail: null,
  step: { type: 'pull_request', number: seq, state, url: `pr/${seq}` },
  replyToId: null,
  threadRootId: null,
  createdAt: '2026-10-16T10:00:00.000Z',
  editedAt: null,
  deletedAt: null,
  needsReply: false,
})
const hasOpenPullRequestWith = (pinnedSteps: readonly MessageRow[], messages: readonly MessageRow[]) =>
  getPublishing(acme, devChat, alice)({ ...createMockSnapshot(), pinnedSteps, messages }).hasOpenPullRequest

test('the newest pull request card decides, whether it is pinned or among the synced messages', () => {
  expect(hasOpenPullRequestWith([cardAt(1, 'open')], [])).toBe(true)
  expect(hasOpenPullRequestWith([cardAt(1, 'open')], [cardAt(5, 'merged')])).toBe(false)
  expect(hasOpenPullRequestWith([cardAt(5, 'draft'), cardAt(1, 'closed')], [cardAt(1, 'closed')])).toBe(true)
  expect(hasOpenPullRequestWith([], [])).toBe(false)
})
