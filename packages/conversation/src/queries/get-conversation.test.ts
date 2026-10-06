import { expect, test } from 'bun:test'
import { createMockSnapshot, type Snapshot } from '@hq/db'
import { chatId, memberId, messageId, workspaceId } from '@hq/kernel'
import { getConversation } from './get-conversation.ts'

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
