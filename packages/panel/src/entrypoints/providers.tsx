import { createCommandsContext } from '@spyria/ui'
import { createContext, type ReactNode, useContext, useState } from 'react'
import type { PanelCommands } from './commands.ts'

export const minimumPanelWidth = 280
export const maximumPanelWidth = 640

type PanelState = { isOpen: boolean; width: number; toggle: () => void; resizeTo: (width: number) => void }

const PanelContext = createContext<PanelState | null>(null)
const [CommandsProvider, usePanelCommands] = createCommandsContext<PanelCommands>('PanelProvider')

export { usePanelCommands }

export const PanelProvider = ({ commands, children }: { commands: PanelCommands; children: ReactNode }) => {
  const [isOpen, setIsOpen] = useState(true)
  const [width, setWidth] = useState(360)
  const resizeTo = (nextWidth: number) => setWidth(Math.min(maximumPanelWidth, Math.max(minimumPanelWidth, nextWidth)))
  return (
    <CommandsProvider commands={commands}>
      <PanelContext value={{ isOpen, width, toggle: () => setIsOpen(!isOpen), resizeTo }}>{children}</PanelContext>
    </CommandsProvider>
  )
}

export const usePanel = () => {
  const state = useContext(PanelContext)
  if (!state) throw new Error('usePanel requires PanelProvider')
  return state
}
