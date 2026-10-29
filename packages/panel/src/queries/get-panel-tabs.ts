import type { Snapshot } from '@spyria/db'
import type { ChatId, WorkspaceId } from '@spyria/kernel'
import { panelChatIn } from './panel-chat.ts'

const allTabs = ['files', 'changes', 'browser', 'sources', 'usage', 'connections', 'members'] as const

export type PanelTabId = (typeof allTabs)[number]

const runtimeTabs = allTabs.filter((tabId) => tabId !== 'sources')
const channelTabs = allTabs.filter((tabId) => !['files', 'changes'].includes(tabId))

export const getPanelTabs = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) => {
  const chat = panelChatIn(snapshot, workspaceId, chatId)
  if (!chat) return null
  return chat.type === 'runtime' ? runtimeTabs : channelTabs
}
