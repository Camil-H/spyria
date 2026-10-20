import type { Snapshot } from '@spyria/db'
import { type ChatId, harnesses, harnessOf, type WorkspaceId } from '@spyria/kernel'
import { installFailureReasonOf, runtimeStatusOf } from '../domain/runtime.ts'

const runtimeOf = (snapshot: Snapshot, workspaceId: WorkspaceId, chatId: ChatId) =>
  snapshot.runtimes.find((runtime) => runtime.workspaceId === workspaceId && runtime.chatId === chatId)

export const getRuntimeStatus = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) => {
  const chat = snapshot.chats.find((candidate) => candidate.workspaceId === workspaceId && candidate.id === chatId)
  return runtimeStatusOf(
    runtimeOf(snapshot, workspaceId, chatId),
    chat?.localSession ? harnesses[harnessOf(chat.harness)].name : undefined,
  )
}

export const getRuntimeFailureReason = (workspaceId: WorkspaceId, chatId: ChatId) => (snapshot: Snapshot) =>
  installFailureReasonOf(runtimeOf(snapshot, workspaceId, chatId)?.failure)
