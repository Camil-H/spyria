import type { WorkspaceId } from '@hq/kernel'
import { archiveChat } from '../operations/archive-chat.ts'
import { archiveProject } from '../operations/archive-project.ts'
import { createChat } from '../operations/create-chat.ts'
import { createProject } from '../operations/create-project.ts'
import { createWorkspace } from '../operations/create-workspace.ts'
import { moveChat } from '../operations/move-chat.ts'
import { renameChat } from '../operations/rename-chat.ts'
import { renameProject } from '../operations/rename-project.ts'

export const workspaceOperations = {
  archiveChat,
  archiveProject,
  createChat,
  createProject,
  createWorkspace,
  moveChat,
  renameChat,
  renameProject,
}

type WorkspaceOperations = typeof workspaceOperations

export type WorkspaceCommands = {
  [Name in keyof WorkspaceOperations]: (
    input: Omit<Parameters<WorkspaceOperations[Name]>[1], 'actorId'> & { workspaceId: WorkspaceId },
  ) => ReturnType<WorkspaceOperations[Name]>
}
