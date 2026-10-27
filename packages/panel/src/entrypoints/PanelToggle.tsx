import { IconButton } from '@spyria/ui'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { panelToggleLabelOf, usePanel } from './providers.tsx'

export const PanelToggle = () => {
  const { isOpen, toggle } = usePanel()
  return (
    <IconButton
      label={panelToggleLabelOf(isOpen)}
      shortcut="r"
      icon={isOpen ? PanelRightClose : PanelRightOpen}
      onClick={toggle}
    />
  )
}
