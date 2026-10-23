import type { Transaction } from '@rocicorp/zero'
import { sentAttachmentOf } from '@spyria/db/server-writes'
import { chatPermissionsOf, type ZeroContext } from '@spyria/db/zero-queries'
import { requireChatPermission, chatId as toChatId } from '@spyria/kernel'
import { AttachmentNotFound } from '../domain/errors.ts'

export const getAttachment = async (tx: Transaction, context: ZeroContext, chatId: string, attachmentId: string) => {
  await requireChatPermission(chatPermissionsOf(tx, context.workspaceId), toChatId(chatId), context.userId, 'chat.read')
  const attachment = await sentAttachmentOf(tx, context.workspaceId, chatId, attachmentId)
  if (!attachment) throw new AttachmentNotFound()
  return attachment
}
