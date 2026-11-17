import { expect, test } from 'bun:test'
import { chatId, messageId, workspaceId } from '@spyria/kernel'
import type { ConversationTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { recordAgentEventEndingLostTurns } from './record-agent-event.ts'

const promptA = messageId('prompt-a')
const promptB = messageId('prompt-b')
const turnEnd = {
  id: 'conversation-1:9',
  kind: 'ACPUpdate',
  timestamp: '2026-11-17T10:00:00Z',
  completed: true,
  update: { sessionUpdate: 'turn_end', stopReason: 'end_turn' },
}

const storeDownWhileTurnIs = (activePromptId: typeof promptB | null) => {
  let failedRecords = 0
  const unitOfWork = { agentTurns: { lock: async () => activePromptId } } as unknown as UnitOfWork
  const transactor: ConversationTransactor = {
    run: async (work) => {
      if (failedRecords < 4) {
        failedRecords += 1
        throw new Error('The event store is down')
      }
      return work(unitOfWork)
    },
  }
  return { transactor }
}

test("a turn end of an earlier prompt that cannot be stored leaves the newer prompt's turn active", async () => {
  const recorded = await recordAgentEventEndingLostTurns(storeDownWhileTurnIs(promptB), {
    workspaceId: workspaceId('acme'),
    chatId: chatId('chat-1'),
    event: turnEnd,
    turnPromptId: promptA,
  })
  expect(recorded).toEqual({ promptId: promptB, isReplyStored: false, expiredSignIn: undefined })
})

test('a turn end that cannot be stored while no turn is active reports no active turn', async () => {
  const recorded = await recordAgentEventEndingLostTurns(storeDownWhileTurnIs(null), {
    workspaceId: workspaceId('acme'),
    chatId: chatId('chat-1'),
    event: turnEnd,
  })
  expect(recorded).toEqual({ promptId: null, isReplyStored: false, expiredSignIn: undefined })
})
