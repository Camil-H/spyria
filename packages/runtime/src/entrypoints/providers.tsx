import { createContext, type ReactNode, use } from 'react'
import type { RuntimeCommands } from './commands.ts'

const RuntimeCommandsContext = createContext<RuntimeCommands | null>(null)

export const RuntimeProvider = ({ commands, children }: { commands: RuntimeCommands; children: ReactNode }) => (
  <RuntimeCommandsContext value={commands}>{children}</RuntimeCommandsContext>
)

export const useRuntimeCommands = () => {
  const commands = use(RuntimeCommandsContext)
  if (!commands) throw new Error('RuntimeProvider is missing')
  return commands
}
