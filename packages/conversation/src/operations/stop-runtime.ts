import { type ChatId, type MemberId, requireChatPermission } from '@spyria/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'

export const stopRuntime = (
  { transactor }: { transactor: ConversationTransactor },
  { chatId, memberId }: { chatId: ChatId; memberId: MemberId },
) =>
  transactor.run(async ({ chats, agentTurns, agentJobs }) => {
    await requireChatPermission(chats, chatId, memberId, 'session.configure')
    const promptId = await agentTurns.lock(chatId)
    if (promptId !== null) await agentJobs.interrupt({ chatId, promptId, memberId })
    await chats.stopRuntime(chatId)
  })
