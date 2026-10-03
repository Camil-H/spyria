import type { ChatId, MemberId, MessageId, WorkspaceId } from '@hq/kernel'

export type ReadMarker = Readonly<{
  workspaceId: WorkspaceId
  memberId: MemberId
  chatId: ChatId
  lastReadMessageId: MessageId
}>

export const advancedReadMarker = (lastReadMessageId: MessageId | null, chatMessageIds: readonly MessageId[]) =>
  chatMessageIds.at(-1) ?? lastReadMessageId
