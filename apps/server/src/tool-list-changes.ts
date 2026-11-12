import type { ChatId, MemberId, WorkspaceId } from '@spyria/kernel'

type Listener = { chatId: ChatId; onChange: () => void }

const listenersByWorkspace = new Map<WorkspaceId, Set<Listener>>()
const listedForByChat = new Map<ChatId, MemberId>()

const listenersOf = (chatId: ChatId) =>
  [...listenersByWorkspace.values()].flatMap((listeners) =>
    [...listeners].filter((listener) => listener.chatId === chatId),
  )

export const watchToolLists = (workspaceId: WorkspaceId, chatId: ChatId, onChange: () => void) => {
  const listener = { chatId, onChange }
  const listeners = listenersByWorkspace.get(workspaceId) ?? new Set()
  listenersByWorkspace.set(workspaceId, listeners.add(listener))
  return () => {
    listeners.delete(listener)
    if (listenersOf(chatId).length === 0) listedForByChat.delete(chatId)
    if (listeners.size === 0) listenersByWorkspace.delete(workspaceId)
  }
}

export const announceToolListChange = (workspaceId: WorkspaceId) => {
  for (const { onChange } of listenersByWorkspace.get(workspaceId) ?? []) onChange()
}

export const recordToolListing = (chatId: ChatId, memberId: MemberId) => {
  if (listenersOf(chatId).length > 0) listedForByChat.set(chatId, memberId)
}

export const announceChatToolListChange = (workspaceId: WorkspaceId, chatId: ChatId) => {
  for (const listener of listenersByWorkspace.get(workspaceId) ?? [])
    if (listener.chatId === chatId) listener.onChange()
}

export const announcePrompter = (workspaceId: WorkspaceId, chatId: ChatId, prompterId: MemberId) => {
  if (listedForByChat.get(chatId) !== prompterId) announceChatToolListChange(workspaceId, chatId)
}
