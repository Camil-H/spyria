import type { ChatId, WorkspaceId } from '@hq/kernel'
import type { ComponentType } from 'react'

export type PanelProps = { workspaceId: WorkspaceId; chatId: ChatId; Markdown: ComponentType<{ text: string }> }
export type TabProps = PanelProps & { actionsSlot: HTMLElement | null }
