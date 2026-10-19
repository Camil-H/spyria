import { createCommandsContext } from '@spyria/ui'
import type { RuntimeCommands } from './commands.ts'

export const [RuntimeProvider, useRuntimeCommands] = createCommandsContext<RuntimeCommands>('RuntimeProvider')
