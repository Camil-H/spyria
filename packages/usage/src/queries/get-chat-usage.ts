import type { Snapshot } from '@hq/db'
import type { ChatId, WorkspaceId } from '@hq/kernel'
import type { ChatUsage, UsageMonth } from '../domain/usage.ts'

export const getChatUsage =
  (_workspaceId: WorkspaceId, _chatId: ChatId, _month: UsageMonth) =>
  (_snapshot: Snapshot): ChatUsage => ({ months: [], rows: [], total: { tokens: 0, costMicros: 0, calls: 0 } })
