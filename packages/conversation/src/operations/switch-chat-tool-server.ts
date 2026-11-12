import { type ChatId, type MemberId, requireChatPermission } from '@spyria/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { toolServersOffAfter } from '../domain/chat-tool-servers.ts'

type Input = { chatId: ChatId; memberId: MemberId; connectionId: string; isOn: boolean }

export const switchChatToolServer = (
  { transactor }: { transactor: ConversationTransactor },
  { chatId, memberId, connectionId, isOn }: Input,
) =>
  transactor.run(async ({ chats }) => {
    await requireChatPermission(chats, chatId, memberId, 'tools.manage')
    const { toolServersOff } = await chats.get(chatId)
    const switched = toolServersOffAfter(toolServersOff, connectionId, isOn)
    if (switched !== toolServersOff) await chats.setToolServersOff(chatId, switched)
  })
