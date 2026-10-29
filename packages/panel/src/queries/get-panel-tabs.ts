import { participantIn, type Snapshot } from '@spyria/db'
import type { ChatId, MemberId, WorkspaceId } from '@spyria/kernel'
import { panelChatIn } from './panel-chat.ts'

const allTabs = ['files', 'changes', 'browser', 'sources', 'usage', 'connections', 'members'] as const

export type PanelTabId = (typeof allTabs)[number]

const runtimeTabs = allTabs.filter((tabId) => tabId !== 'sources')
const channelTabs = allTabs.filter((tabId) => !['files', 'changes'].includes(tabId))
const withoutOwnerConnections = (tabIds: readonly PanelTabId[]) => tabIds.filter((tabId) => tabId !== 'connections')
const runtimeTabsOfReaders = withoutOwnerConnections(runtimeTabs)
const channelTabsOfReaders = withoutOwnerConnections(channelTabs)

export const getPanelTabs = (workspaceId: WorkspaceId, chatId: ChatId, viewerId: MemberId) => (snapshot: Snapshot) => {
  const chat = panelChatIn(snapshot, workspaceId, chatId)
  if (!chat) return null
  const takesPart = participantIn(snapshot, workspaceId, viewerId)(chat) !== undefined
  if (chat.type === 'runtime') return takesPart ? runtimeTabs : runtimeTabsOfReaders
  return takesPart ? channelTabs : channelTabsOfReaders
}
