import { createContext, type ReactNode, use } from 'react'
import type { WorkspaceCommands } from './commands.ts'

const WorkspaceCommandsContext = createContext<WorkspaceCommands | null>(null)

export const WorkspaceProvider = ({ commands, children }: { commands: WorkspaceCommands; children: ReactNode }) => (
  <WorkspaceCommandsContext value={commands}>{children}</WorkspaceCommandsContext>
)

export const useWorkspaceCommands = () => {
  const commands = use(WorkspaceCommandsContext)
  if (!commands) throw new Error('WorkspaceProvider is missing')
  return commands
}
