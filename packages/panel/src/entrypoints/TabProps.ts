import type { ChatId, WorkspaceId } from '@hq/kernel'
import type { ComponentType } from 'react'

export type TabProps = { workspaceId: WorkspaceId; chatId: ChatId; Markdown: ComponentType<{ text: string }> }
