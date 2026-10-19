import { createCommandsContext } from '@spyria/ui'
import type { UsageCommands } from './commands.ts'

export const [UsageProvider, useUsageCommands] = createCommandsContext<UsageCommands>('UsageProvider')
