import { createContext, type ReactNode, use } from 'react'

export const createCommandsContext = <Commands,>(providerName: string) => {
  const CommandsContext = createContext<Commands | null>(null)
  const Provider = ({ commands, children }: { commands: Commands; children: ReactNode }) => (
    <CommandsContext value={commands}>{children}</CommandsContext>
  )
  const useCommands = () => {
    const commands = use(CommandsContext)
    if (!commands) throw new Error(`${providerName} is missing`)
    return commands
  }
  return [Provider, useCommands] as const
}
