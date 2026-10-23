import { findChat, type Snapshot } from '@spyria/db'
import type { ChatId, WorkspaceId } from '@spyria/kernel'

const allTabs = ['files', 'changes', 'commits', 'browser', 'sources', 'usage', 'connections', 'members'] as const

export type PanelTabId = (typeof allTabs)[number]

const runtimeTabs = allTabs.filter((tabId) => tabId !== 'sources')
const channelTabs = allTabs.filter((tabId) => !['files', 'changes', 'commits'].includes(tabId))

export const getPanelTabs = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) => {
  const chat = findChat(snapshot, workspaceId, chatId)
  if (!chat) return null
  return chat.type === 'runtime' ? runtimeTabs : channelTabs
}
