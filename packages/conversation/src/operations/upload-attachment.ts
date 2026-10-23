import { type ChatId, type MemberId, requireChatPermission } from '@spyria/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { allowedMediaFormatOf, attachmentNameOf } from '../domain/attachments.ts'
import { requireNotFrozen } from '../domain/message.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { id: string; chatId: ChatId; uploaderId: MemberId; name: string; content: Uint8Array }

export const uploadAttachment = ({ transactor }: Dependencies, { id, chatId, uploaderId, name, content }: Input) => {
  const attachment = {
    id,
    name: attachmentNameOf(name),
    mediaType: allowedMediaFormatOf(content).mediaType,
    size: content.length,
  }
  return transactor.run(async ({ chats, attachments }) => {
    await requireChatPermission(chats, chatId, uploaderId, 'chat.post')
    requireNotFrozen(await chats.get(chatId))
    await attachments.store({ ...attachment, chatId, uploaderId, content })
    return attachment
  })
}
