import { acme, type ChatRow, type Snapshot, bob } from '@hq/db'
import { chatId, type MemberId } from '@hq/kernel'

export const withChannel = (
  snapshot: Snapshot,
  {
    name,
    visibility,
    participantIds = [],
  }: { name: string; visibility: ChatRow['visibility']; participantIds?: MemberId[] },
): Snapshot => {
  const welcome = snapshot.chats.find((chat) => chat.name === 'Welcome') as ChatRow
  const id = chatId(`chat-${name.toLowerCase()}`)
  return {
    ...snapshot,
    chats: [...snapshot.chats, { ...welcome, id, name, visibility, ownerId: bob, projectId: null }],
    chatMembers: [
      ...snapshot.chatMembers,
      { workspaceId: acme, chatId: id, memberId: bob, roleId: 'owner' },
      ...participantIds.map((memberId) => ({ workspaceId: acme, chatId: id, memberId, roleId: 'prompter' })),
    ],
  }
}
