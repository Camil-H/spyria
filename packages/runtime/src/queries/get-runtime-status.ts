import type { Snapshot } from '@hq/db'
import type { ChatId, WorkspaceId } from '@hq/kernel'
import { runtimeStatusOf } from '../domain/runtime.ts'

export const getRuntimeStatus = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) =>
  runtimeStatusOf(snapshot.runtimes.find((runtime) => runtime.workspaceId === workspaceId && runtime.chatId === chatId))
