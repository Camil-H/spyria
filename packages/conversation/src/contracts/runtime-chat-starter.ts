import type { ChatId, MemberId } from '@spyria/kernel'

export type RuntimeChatStarter = {
  start(input: { id: ChatId; sourceChatId: ChatId; name: string; ownerId: MemberId }): Promise<void>
}
