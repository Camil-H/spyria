import { createCommandsContext } from '@spyria/ui'
import { createContext, type ReactNode, useContext, useState } from 'react'
import type { PanelCommands } from './commands.ts'

export const minimumPanelWidth = 280
export const panelToggleLabelOf = (isOpen: boolean) => (isOpen ? 'Hide panel' : 'Show panel')
export const minimumChatWidth = 320
export const panelWidthVariable = '--panel-width'

type PanelState = {
  isOpen: boolean
  width: number
  maximumWidth: number
  toggle: () => void
  open: () => void
  resizeTo: (width: number) => void
  fitWithin: (availableWidth: number) => void
}

const PanelContext = createContext<PanelState | null>(null)
const [CommandsProvider, usePanelCommands] = createCommandsContext<PanelCommands>('PanelProvider')

export { usePanelCommands }

export const PanelProvider = ({ commands, children }: { commands: PanelCommands; children: ReactNode }) => {
  const [isOpen, setIsOpen] = useState(true)
  const [preferredWidth, setPreferredWidth] = useState(360)
  const [availableWidth, setAvailableWidth] = useState(Number.POSITIVE_INFINITY)
  const maximumWidth = Math.max(minimumPanelWidth, Math.floor(availableWidth - minimumChatWidth))
  return (
    <CommandsProvider commands={commands}>
      <PanelContext
        value={{
          isOpen,
          width: Math.min(maximumWidth, preferredWidth),
          maximumWidth,
          toggle: () => setIsOpen(!isOpen),
          open: () => setIsOpen(true),
          resizeTo: setPreferredWidth,
          fitWithin: setAvailableWidth,
        }}
      >
        {children}
      </PanelContext>
    </CommandsProvider>
  )
}

export const usePanel = () => {
  const state = useContext(PanelContext)
  if (!state) throw new Error('usePanel requires PanelProvider')
  return state
}
