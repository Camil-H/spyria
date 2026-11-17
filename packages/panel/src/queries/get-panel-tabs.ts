import { participantIn, type Snapshot } from '@spyria/db'
import type { ChatId, MemberId, WorkspaceId } from '@spyria/kernel'
import { panelChatIn } from './panel-chat.ts'

const allTabs = ['changes', 'files', 'browser', 'usage', 'connections', 'members'] as const

export type PanelTabId = (typeof allTabs)[number]

const runtimeTabsOfReaders = allTabs.filter((tabId) => tabId !== 'connections')
const channelTabs = ['members'] as const satisfies readonly PanelTabId[]

export const getPanelTabs = (workspaceId: WorkspaceId, chatId: ChatId, viewerId: MemberId) => (snapshot: Snapshot) => {
  const chat = panelChatIn(snapshot, workspaceId, chatId)
  if (!chat) return null
  if (chat.type === 'channel') return channelTabs
  const takesPart = participantIn(snapshot, workspaceId, viewerId)(chat) !== undefined
  return takesPart ? allTabs : runtimeTabsOfReaders
}
