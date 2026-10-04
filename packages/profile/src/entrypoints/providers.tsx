import { createContext, type ReactNode, use } from 'react'
import type { ProfileCommands } from './commands.ts'

const ProfileCommandsContext = createContext<ProfileCommands | null>(null)

export const ProfileProvider = ({ commands, children }: { commands: ProfileCommands; children: ReactNode }) => (
  <ProfileCommandsContext value={commands}>{children}</ProfileCommandsContext>
)

export const useProfileCommands = () => {
  const commands = use(ProfileCommandsContext)
  if (!commands) throw new Error('ProfileProvider is missing')
  return commands
}
