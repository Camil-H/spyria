import { inChat, type MessageRow, type Snapshot } from '@spyria/db'
import type { ChatId, MemberId, MessageId, WorkspaceId } from '@spyria/kernel'

const latestOf = (latest: MessageRow | undefined, message: MessageRow) =>
  latest && latest.seq > message.seq ? latest : message

export const getLastSentText =
  (workspaceId: WorkspaceId, chatId: ChatId, memberId: MemberId, threadRootId: MessageId | null) =>
  (snapshot: Snapshot) =>
    snapshot.messages
      .filter(
        (message) =>
          inChat(workspaceId, chatId)(message) &&
          message.kind === 'member' &&
          message.authorId === memberId &&
          message.threadRootId === threadRootId &&
          message.deletedAt === null &&
          message.body !== '',
      )
      .reduce<MessageRow | undefined>(latestOf, undefined)?.body ?? ''
