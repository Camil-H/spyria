import { iconButtonClass } from '@hq/ui'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { usePanel } from './providers.tsx'

export const PanelToggle = () => {
  const { isOpen, toggle } = usePanel()
  const Icon = isOpen ? PanelRightClose : PanelRightOpen
  return (
    <button
      type="button"
      aria-label={isOpen ? 'Hide panel' : 'Show panel'}
      onClick={toggle}
      className={iconButtonClass}
    >
      <Icon size={18} />
    </button>
  )
}
