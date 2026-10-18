import { findChat, type Snapshot } from '@hq/db'
import type { ChatId, WorkspaceId } from '@hq/kernel'

const allTabs = [
  'files',
  'changes',
  'plan',
  'commits',
  'browser',
  'sources',
  'usage',
  'connections',
  'members',
] as const

export type PanelTabId = (typeof allTabs)[number]

const runtimeTabs = allTabs.filter((tabId) => tabId !== 'sources')
const channelTabs = allTabs.filter((tabId) => !['files', 'changes', 'plan', 'commits'].includes(tabId))

export const getPanelTabs = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) => {
  const chat = findChat(snapshot, workspaceId, chatId)
  if (!chat) return null
  return chat.type === 'runtime' ? runtimeTabs : channelTabs
}
