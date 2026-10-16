import { createCommandsContext } from '@hq/ui'
import type { WorkspaceCommands } from './commands.ts'

export const [WorkspaceProvider, useWorkspaceCommands] = createCommandsContext<WorkspaceCommands>('WorkspaceProvider')
