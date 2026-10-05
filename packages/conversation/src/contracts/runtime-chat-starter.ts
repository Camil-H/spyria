import type { ChatId, MemberId } from '@hq/kernel'

export type RuntimeChatStarter = {
  start(input: { id: ChatId; sourceChatId: ChatId; name: string; ownerId: MemberId }): Promise<void>
}
