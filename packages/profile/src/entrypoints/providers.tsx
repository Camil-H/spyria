import { createCommandsContext } from '@hq/ui'
import type { ProfileCommands } from './commands.ts'

export const [ProfileProvider, useProfileCommands] = createCommandsContext<ProfileCommands>('ProfileProvider')
