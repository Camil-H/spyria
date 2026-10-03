import type { ChatId, MemberId } from '@hq/kernel'

export type RuntimeChatStarter = {
  start(input: { sourceChatId: ChatId; name: string; ownerId: MemberId }): Promise<{ chatId: ChatId }>
}
