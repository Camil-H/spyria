import { createCommandsContext } from '@spyria/ui'
import type { WorkspaceCommands } from './commands.ts'

export const [WorkspaceProvider, useWorkspaceCommands] = createCommandsContext<WorkspaceCommands>('WorkspaceProvider')
