import { createContext, type ReactNode, useContext, useState } from 'react'

export const minimumPanelWidth = 280
export const maximumPanelWidth = 640

type PanelState = { isOpen: boolean; width: number; toggle: () => void; resizeTo: (width: number) => void }

const PanelContext = createContext<PanelState | null>(null)

export const PanelProvider = ({ children }: { children: ReactNode }) => {
  const [isOpen, setIsOpen] = useState(true)
  const [width, setWidth] = useState(360)
  const resizeTo = (nextWidth: number) => setWidth(Math.min(maximumPanelWidth, Math.max(minimumPanelWidth, nextWidth)))
  return <PanelContext value={{ isOpen, width, toggle: () => setIsOpen(!isOpen), resizeTo }}>{children}</PanelContext>
}

export const usePanel = () => {
  const state = useContext(PanelContext)
  if (!state) throw new Error('usePanel requires PanelProvider')
  return state
}
