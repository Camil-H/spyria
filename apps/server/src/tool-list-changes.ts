import type { ChatId, MemberId, WorkspaceId } from '@spyria/kernel'

type Listener = { chatId: ChatId; onChange: () => void }

const listenersByWorkspace = new Map<WorkspaceId, Set<Listener>>()
const listedForByChat = new Map<ChatId, MemberId>()

export const watchToolLists = (workspaceId: WorkspaceId, chatId: ChatId, onChange: () => void) => {
  const listener = { chatId, onChange }
  const listeners = listenersByWorkspace.get(workspaceId) ?? new Set()
  listenersByWorkspace.set(workspaceId, listeners.add(listener))
  return () => {
    listeners.delete(listener)
    if (![...listeners].some((other) => other.chatId === chatId)) listedForByChat.delete(chatId)
    if (listeners.size === 0) listenersByWorkspace.delete(workspaceId)
  }
}

export const announceToolListChange = (workspaceId: WorkspaceId) => {
  for (const { onChange } of listenersByWorkspace.get(workspaceId) ?? []) onChange()
}

export const recordToolListing = (chatId: ChatId, memberId: MemberId) => listedForByChat.set(chatId, memberId)

export const announcePrompter = (workspaceId: WorkspaceId, chatId: ChatId, prompterId: MemberId) => {
  const listedFor = listedForByChat.get(chatId)
  if (listedFor === undefined || listedFor === prompterId) return
  for (const listener of listenersByWorkspace.get(workspaceId) ?? [])
    if (listener.chatId === chatId) listener.onChange()
}
