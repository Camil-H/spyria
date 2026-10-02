import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { usePanel } from './providers.tsx'
import { focusRing } from './ui.ts'

export const PanelToggle = () => {
  const { isOpen, toggle } = usePanel()
  const Icon = isOpen ? PanelRightClose : PanelRightOpen
  return (
    <button
      type="button"
      aria-label={isOpen ? 'Hide panel' : 'Show panel'}
      onClick={toggle}
      className={`rounded-md p-1.5 text-muted hover:bg-hover hover:text-ink ${focusRing}`}
    >
      <Icon size={18} />
    </button>
  )
}
