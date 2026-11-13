import type { Database } from '@spyria/db/postgres'
import type { ChatId, MemberId, WorkspaceId } from '@spyria/kernel'

type Listener = { chatId: ChatId; onChange: () => void }

export const createToolListChanges = () => {
  const listenersByWorkspace = new Map<WorkspaceId, Set<Listener>>()
  const listedForByChat = new Map<string, MemberId>()
  const chatKeyOf = (workspaceId: WorkspaceId, chatId: ChatId) => `${workspaceId}/${chatId}`
  const listenersOf = (workspaceId: WorkspaceId, chatId: ChatId) =>
    [...(listenersByWorkspace.get(workspaceId) ?? [])].filter((listener) => listener.chatId === chatId)

  const announceChatToolListChange = (workspaceId: WorkspaceId, chatId: ChatId) => {
    for (const { onChange } of listenersOf(workspaceId, chatId)) onChange()
  }

  return {
    watchToolLists: (workspaceId: WorkspaceId, chatId: ChatId, onChange: () => void) => {
      const listener = { chatId, onChange }
      const listeners = listenersByWorkspace.get(workspaceId) ?? new Set()
      listenersByWorkspace.set(workspaceId, listeners.add(listener))
      return () => {
        listeners.delete(listener)
        if (listenersOf(workspaceId, chatId).length === 0) listedForByChat.delete(chatKeyOf(workspaceId, chatId))
        if (listeners.size === 0) listenersByWorkspace.delete(workspaceId)
      }
    },
    announceToolListChange: (workspaceId: WorkspaceId) => {
      for (const { onChange } of listenersByWorkspace.get(workspaceId) ?? []) onChange()
    },
    recordToolListing: (workspaceId: WorkspaceId, chatId: ChatId, memberId: MemberId) => {
      if (listenersOf(workspaceId, chatId).length > 0) listedForByChat.set(chatKeyOf(workspaceId, chatId), memberId)
    },
    announceChatToolListChange,
    announcePrompter: (workspaceId: WorkspaceId, chatId: ChatId, prompterId: MemberId) => {
      if (listedForByChat.get(chatKeyOf(workspaceId, chatId)) !== prompterId)
        announceChatToolListChange(workspaceId, chatId)
    },
  }
}

const toolListChangesByDatabase = new WeakMap<Database, ReturnType<typeof createToolListChanges>>()

export const toolListChangesOf = (database: Database) => {
  const changes = toolListChangesByDatabase.get(database) ?? createToolListChanges()
  toolListChangesByDatabase.set(database, changes)
  return changes
}
