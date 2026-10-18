import { expect, test } from 'bun:test'
import { acme, createMockSnapshot, type MessageRow } from '@hq/db'
import { chatId, messageId } from '@hq/kernel'
import { getTerminal } from './get-terminal.ts'

const terminalChat = chatId('chat-terminal')
const commandOf = (seq: number, replyToId: string, exitCode: number | null): MessageRow => ({
  id: messageId(`command-${seq}`),
  workspaceId: acme,
  chatId: terminalChat,
  seq,
  kind: 'step',
  authorId: null,
  body: 'command',
  detail: null,
  step: { type: 'command', command: `echo ${seq}`, output: `${seq}\n`, exitCode },
  replyToId: messageId(replyToId),
  threadRootId: null,
  createdAt: '2026-10-18T10:00:00.000Z',
  editedAt: null,
  deletedAt: null,
  needsReply: false,
})

test('a command without an exit code runs only while its turn is the chat’s active turn, else it stopped', () => {
  const snapshot = createMockSnapshot()
  const [chat] = snapshot.chats
  if (!chat) throw new Error('The mock snapshot has no chat')
  const terminalOf = (agentTurnMessageId: string | null) =>
    getTerminal(
      acme,
      terminalChat,
    )({
      ...snapshot,
      chats: [
        {
          ...chat,
          id: terminalChat,
          workspaceId: acme,
          agentTurnMessageId: agentTurnMessageId === null ? null : messageId(agentTurnMessageId),
        },
      ],
      messages: [commandOf(1, 'prompt-1', null), commandOf(2, 'prompt-2', 0), commandOf(3, 'prompt-2', null)],
    }).map(({ stepId, exitCode, isRunning }) => `${stepId} ${exitCode} ${isRunning}`)
  expect(terminalOf('prompt-2')).toEqual(['command-1 null false', 'command-2 0 false', 'command-3 null true'])
  expect(terminalOf(null)).toEqual(['command-1 null false', 'command-2 0 false', 'command-3 null false'])
})
