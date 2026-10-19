import type { Snapshot } from '@spyria/db'
import type { ChatId, WorkspaceId } from '@spyria/kernel'
import { runtimeStatusOf } from '../domain/runtime.ts'

export const getRuntimeStatus = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) =>
  runtimeStatusOf(snapshot.runtimes.find((runtime) => runtime.workspaceId === workspaceId && runtime.chatId === chatId))
