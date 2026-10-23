import { type ChatId, type MemberId, requireChatPermission } from '@spyria/kernel'
import type { ConversationTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { allowedMediaFormatOf, attachmentNameOf, requireRoomFor } from '../domain/attachments.ts'
import { requireNotFrozen } from '../domain/message.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = {
  id: string
  chatId: ChatId
  uploaderId: MemberId
  name: string
  readContent: () => Promise<Uint8Array>
}

export const uploadAttachment = async (
  { transactor }: Dependencies,
  { id, chatId, uploaderId, name, readContent }: Input,
) => {
  const requireMayUpload = async ({ chats }: Pick<UnitOfWork, 'chats'>) => {
    await requireChatPermission(chats, chatId, uploaderId, 'chat.post')
    requireNotFrozen(await chats.get(chatId))
  }
  await transactor.run(requireMayUpload)
  const content = await readContent()
  const attachment = {
    id,
    name: attachmentNameOf(name),
    mediaType: allowedMediaFormatOf(content).mediaType,
    size: content.length,
  }
  return transactor.run(async (unitOfWork) => {
    await requireMayUpload(unitOfWork)
    requireRoomFor(attachment.size, await unitOfWork.attachments.storedBytes(uploaderId))
    await unitOfWork.attachments.store({ ...attachment, chatId, uploaderId, content })
    return attachment
  })
}
